import { createLogger } from "../logger";
import type { E2BSandboxProvider } from "../sandbox/providers/e2b-provider";
import type { ImageBuildProviderImageRef } from "./model";
import type {
  DeleteImageInput,
  E2BImageBuildPlan,
  FailedImageBuildInput,
  FinalizeImageBuildInput,
  ImageBuildAdapter,
  ImageBuildStartCallbacks,
} from "./types";

const logger = createLogger("image-builds:e2b-adapter");
const MS_PER_SECOND = 1000;

/**
 * E2B adapter for provider-session image builds.
 *
 * Builds run in a temporary E2B sandbox. On success, the adapter bakes that
 * sandbox's filesystem into a reusable snapshot template; teardown kills the
 * build sandbox (E2B stop only pauses, which would leak the single-use box).
 *
 * Quiescing the build process before the snapshot is owned by the provider's
 * takeSnapshot (pause keepMemory:false → connect cold-boot → snapshot), so the
 * adapter neither waits nor guesses when the build supervisor has exited.
 */
export class E2BImageBuildAdapter implements ImageBuildAdapter<E2BImageBuildPlan> {
  constructor(private readonly provider: E2BSandboxProvider) {}

  async startBuild(plan: E2BImageBuildPlan, callbacks: ImageBuildStartCallbacks): Promise<void> {
    await this.provider.triggerEnvironmentImageBuild({
      // The provider build API is keyed by environmentId (used only for
      // sandbox naming/metadata); scope.id fills it for every scope kind.
      environmentId: plan.scope.id,
      repositories: plan.repositories,
      buildId: plan.buildId,
      callbackUrl: plan.callbackUrl,
      failureCallbackUrl: plan.failureCallbackUrl,
      callbackToken: plan.callbackToken,
      userEnvVars: plan.userEnvVars,
      cloneToken: plan.cloneAuth.type === "credential_helper" ? plan.cloneAuth.token : undefined,
      buildTimeoutSeconds: Math.ceil(plan.buildTimeoutMs / MS_PER_SECOND),
      onProviderSessionCreated: callbacks.bindProviderSession,
    });
  }

  async finalizeSuccessfulBuild(
    input: FinalizeImageBuildInput
  ): Promise<ImageBuildProviderImageRef> {
    try {
      const snapshot = await this.provider.takeSnapshot({
        providerObjectId: input.providerSessionId,
        sessionId: input.buildId,
        reason: "environment_image_build",
        correlation: {
          ...input.correlation,
          sandbox_id: input.providerSessionId,
        },
      });

      if (!snapshot.success || !snapshot.imageId) {
        throw new Error(snapshot.error || "E2B snapshot did not return an image id");
      }

      return {
        providerImageId: snapshot.imageId,
        providerSessionId: input.providerSessionId,
      };
    } finally {
      await this.deleteBuildSandbox(input.buildId, input.providerSessionId, input.correlation);
    }
  }

  async cleanupFailedBuild(input: FailedImageBuildInput): Promise<void> {
    await this.deleteBuildSandbox(input.buildId, input.providerSessionId, input.correlation);
  }

  async deleteImage(input: DeleteImageInput): Promise<void> {
    await this.provider.deleteProviderImage(input.image.providerImageId);
  }

  private async deleteBuildSandbox(
    buildId: string,
    providerSessionId: string,
    correlation: FinalizeImageBuildInput["correlation"]
  ): Promise<void> {
    try {
      await this.provider.deleteSandbox(providerSessionId);
    } catch (error) {
      logger.warn("image_build.e2b_build_cleanup_failed", {
        build_id: buildId,
        provider_session_id: providerSessionId,
        error: error instanceof Error ? error.message : String(error),
        request_id: correlation.request_id,
        trace_id: correlation.trace_id,
      });
    }
  }
}
