/**
 * E2B sandbox provider — calls the E2B REST API directly.
 *
 * Stop is a resumable pause (like Daytona's stop), so the shared lifecycle
 * manager's persistent-resume path drives idle-pause and resume with no
 * E2B-specific plumbing. Sandboxes are created with auto-pause (a lapsed TTL pauses
 * recoverably rather than killing) and secure envd access; provider-side auto-resume is
 * disabled so resume stays control-plane-driven (connectSandbox) and stray traffic can't
 * wake a paused box. Per-session env is delivered via an envd file write because the
 * template's start command runs at build time.
 *
 * Prebuilt images (snapshots): the image-build workflow runs `.openinspect/setup.sh`
 * once in a build sandbox (triggerEnvironmentImageBuild), then bakes its filesystem
 * into a reusable snapshot template (takePrebuiltImageSnapshot →
 * `POST /sandboxes/{id}/snapshots`).
 * The snapshot id doubles as a `templateID`, so a prebuilt/restored sandbox is just a
 * create with that id in place of the base template. The snapshot resumes oi-launch
 * in its env wait loop, where it reads the freshly written per-session env — so
 * prebuilt boots reuse the baked filesystem while still getting fresh session config.
 */

import { DEFAULT_BUILD_TIMEOUT_SECONDS, type SandboxSettings } from "@open-inspect/shared";
import { createLogger } from "../../logger";
import {
  applyScmCloneEnv,
  buildSandboxEnvVars,
  deriveCodeServerPassword,
  IMAGE_BUILD_MODE_ENV_VAR,
  scmCloneIdentity,
  SESSION_CONFIG_ENV_VAR,
  toRepositoryConfigPayload,
} from "../sandbox-env";
import { resolveServicePorts, resolveTunnelPorts } from "./port-resolution";
import type { SourceControlProviderName } from "../../source-control";
import type { E2BRestClient, E2BSandboxCreated, E2BSandboxDetail } from "../e2b-rest-client";
import { E2BApiError, E2BConflictError, E2BNotFoundError } from "../e2b-rest-client";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type RestoreConfig,
  type RestoreResult,
  type ResumeConfig,
  type ResumeResult,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type SnapshotConfig,
  type SnapshotResult,
  type StopConfig,
  type StopResult,
} from "../provider";

const log = createLogger("e2b-provider");

/** Sandbox TTL default. Hobby plans (~1h cap) should lower this via config. */
export const DEFAULT_E2B_SANDBOX_TIMEOUT_SECONDS = DEFAULT_SANDBOX_TIMEOUT_SECONDS;
/** Default to a recoverable stop: pause on TTL (not kill), so it stays resumable. */
export const DEFAULT_E2B_AUTO_PAUSE = true;

/**
 * Runtime version baked into the E2B template, reported by build sandboxes so
 * spawn-time selection can gate on the compatibility floor
 * (MIN_COMPATIBLE_RUNTIME_VERSION). E2B does not propagate the Dockerfile's
 * SANDBOX_VERSION to the runtime process, so builds get it here instead. Keep in
 * sync with the toolchain pinned in e2b.Dockerfile (OPENCODE_VERSION) and the
 * matching Vercel/OpenComputer constants.
 */
export const E2B_SANDBOX_VERSION = "v54-opencode-1-17-18";

/**
 * TTL for the brief cold-boot between the sanitizing pause and createSnapshot
 * during an image build. Only needs to outlive the snapshot call; the build
 * sandbox is killed immediately afterwards.
 */
const SNAPSHOT_CONNECT_TIMEOUT_SECONDS = 300;

const REPO_IMAGE_CALLBACK_ENV_KEYS = [
  "OI_REPO_IMAGE_PROVIDER_SESSION_ID",
  "OI_REPO_IMAGE_BUILD_ID",
  "OI_REPO_IMAGE_CALLBACK_URL",
  "OI_REPO_IMAGE_CALLBACK_TOKEN",
  "OI_REPO_IMAGE_FAILURE_CALLBACK_URL",
] as const;
const RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS = [
  ...REPO_IMAGE_CALLBACK_ENV_KEYS,
  "OI_REPO_IMAGE_CALLBACK_SECRET",
] as const;

export interface E2BProviderConfig {
  scmProvider: SourceControlProviderName;
  codeServerPasswordSecret: string;
  sandboxTimeoutSeconds: number;
  /**
   * Pause (not kill) when the sandbox TTL expires, so it stays resumable. Resume is
   * control-plane-driven (connectSandbox); provider-side auto-resume is not used.
   */
  autoPause: boolean;
}

export interface TriggerE2BEnvironmentImageBuildConfig {
  buildId: string;
  environmentId: string;
  /** Repositories in position order ([0] = primary), cloned at their base branches. */
  repositories: Array<{ repoOwner: string; repoName: string; baseBranch: string }>;
  callbackUrl: string;
  failureCallbackUrl: string;
  callbackToken: string;
  userEnvVars?: Record<string, string>;
  cloneToken?: string;
  buildTimeoutSeconds?: number;
  onProviderSessionCreated?: (providerSessionId: string) => Promise<void>;
}

export interface TriggerE2BEnvironmentImageBuildResult {
  buildId: string;
  status: string;
}

type E2BOperation = "create" | "resume" | "stop" | "snapshot" | "delete";

export class E2BSandboxProvider implements SandboxProvider {
  readonly name = "e2b";

  /**
   * Stop reasons that are terminal (the manager sets the session `failed` and
   * never resumes it) — kill instead of pausing to avoid orphaning a sandbox.
   */
  private static readonly TERMINAL_STOP_REASONS = new Set(["connecting_timeout"]);

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSnapshots: true,
    supportsRestore: true,
    // Stop is a resumable pause; the manager treats it as provider-managed state.
    supportsPersistentResume: true,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly client: E2BRestClient,
    private readonly providerConfig: E2BProviderConfig
  ) {}

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      // A prebuilt image id is an E2B snapshot template id — spawn from it instead
      // of the base template and mark the boot so the runtime skips setup.sh (it
      // ran at build time). Otherwise fall back to the base template.
      const extraEnv: Record<string, string> = {};
      if (config.prebuiltImageId) {
        extraEnv.FROM_REPO_IMAGE = "true";
        extraEnv.REPO_IMAGE_SHA = config.prebuiltImageSha ?? "";
      }
      const templateId = config.prebuiltImageId || this.client.config.templateId;
      const spawned = await this.spawnFromTemplate(config, templateId, extraEnv);

      return {
        sandboxId: config.sandboxId,
        providerObjectId: spawned.providerObjectId,
        status: "running",
        createdAt: spawned.createdAt,
        codeServerUrl: spawned.codeServerUrl,
        codeServerPassword: spawned.codeServerPassword,
        tunnelUrls: spawned.tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to create E2B sandbox", error, "create");
    }
  }

  async restoreFromSnapshot(config: RestoreConfig): Promise<RestoreResult> {
    let sandbox: E2BSandboxCreated | undefined;
    try {
      const { envVars, codeServerPassword } = await this.buildRuntimeEnv(config, {
        RESTORED_FROM_SNAPSHOT: "true",
      });
      // Session snapshots preserve process memory. Start them without outbound
      // network access so the captured supervisor cannot use stale credentials
      // before we replace it with a clean launcher.
      sandbox = await this.client.createSandbox({
        templateID: config.snapshotImageId,
        metadata: this.buildMetadata(config),
        timeoutSeconds: config.timeoutSeconds ?? this.providerConfig.sandboxTimeoutSeconds,
        autoPause: this.providerConfig.autoPause,
        autoResume: false,
        secure: true,
        allowInternetAccess: false,
      });

      // Drop the captured process memory, then cold-boot the template launcher.
      // connect returns a fresh envd token for the secure sandbox.
      await this.client.pauseSandbox(sandbox.sandboxID, { memory: false });
      const connected = await this.client.connectSandbox(
        sandbox.sandboxID,
        config.timeoutSeconds ?? this.providerConfig.sandboxTimeoutSeconds
      );
      await this.client.updateSandboxNetwork(sandbox.sandboxID, { allowInternetAccess: true });
      await this.deliverSessionEnv(
        {
          sandboxID: connected.sandboxID,
          templateID: connected.templateID,
          domain: connected.domain ?? sandbox.domain,
          envdAccessToken: connected.envdAccessToken,
        },
        envVars
      );

      const { codeServerUrl, tunnelUrls } = this.buildTunnelUrls(
        connected.sandboxID,
        config.codeServerEnabled,
        config.sandboxSettings,
        connected.domain ?? sandbox.domain
      );

      return {
        success: true,
        sandboxId: config.sandboxId,
        providerObjectId: connected.sandboxID,
        codeServerUrl,
        codeServerPassword,
        tunnelUrls,
      };
    } catch (error) {
      if (sandbox) {
        await this.cleanupSandbox(sandbox.sandboxID, "e2b.restore_cleanup_kill_failed");
      }
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to restore E2B sandbox from snapshot", error, "create");
    }
  }

  /**
   * Take a resumable snapshot of a live session without changing its runtime
   * state. This is the generic lifecycle operation used after a prompt.
   */
  async takeSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      return await this.createSnapshotResult(config.providerObjectId);
    } catch (error) {
      throw this.classifyError("Failed to snapshot E2B sandbox", error, "snapshot");
    }
  }

  /**
   * Bake an image-build sandbox into a reusable snapshot template, sanitized so
   * the image is a clean, quiescent cold boot rather than a frozen build process.
   *
   * A reusable E2B snapshot (`POST /sandboxes/{id}/snapshots`) captures live
   * process memory, so snapshotting the running build sandbox directly would (a)
   * bake the build supervisor and its secret env into every image and (b) resume
   * that stale process on spawn instead of a fresh launcher. To avoid both, we
   * first `pause(keepMemory:false)` — which drops all memory and persists only
   * the filesystem — then `connect`, which cold-boots the sandbox from disk,
   * re-running the launcher fresh in its env-wait state. The snapshot then
   * captures that clean state, so sandboxes spawned from it start a fresh
   * supervisor with their own per-session env (and never inherit build secrets in
   * memory).
   */
  async takePrebuiltImageSnapshot(config: SnapshotConfig): Promise<SnapshotResult> {
    try {
      await this.client.pauseSandbox(config.providerObjectId, { memory: false });
      // Cold-boot from disk; connect returns once the template ready-check passes,
      // i.e. once the launcher is back up and waiting — no readiness guesswork.
      await this.client.connectSandbox(config.providerObjectId, SNAPSHOT_CONNECT_TIMEOUT_SECONDS);
      // No name: each build gets a distinct snapshot template. Superseded images
      // are reclaimed by the reaper via deleteProviderImage, so reusing a name
      // (which would reassign builds to one template) buys nothing.
      return await this.createSnapshotResult(config.providerObjectId);
    } catch (error) {
      throw this.classifyError("Failed to bake E2B image snapshot", error, "snapshot");
    }
  }

  async resumeSandbox(config: ResumeConfig): Promise<ResumeResult> {
    try {
      let sandbox: E2BSandboxDetail;
      try {
        sandbox = await this.client.getSandbox(config.providerObjectId);
      } catch (error) {
        if (error instanceof E2BNotFoundError) {
          return {
            success: false,
            error: "Sandbox no longer exists in E2B",
            shouldSpawnFresh: true,
          };
        }
        throw error;
      }

      const timeoutSeconds = config.timeoutSeconds ?? this.providerConfig.sandboxTimeoutSeconds;
      try {
        if (sandbox.state === "paused") {
          await this.client.connectSandbox(config.providerObjectId, timeoutSeconds);
        } else if (sandbox.state === "running") {
          await this.client.setSandboxTimeout(config.providerObjectId, timeoutSeconds);
        } else {
          return {
            success: false,
            error: `Sandbox in non-resumable state: ${sandbox.state}`,
            shouldSpawnFresh: true,
          };
        }
      } catch (error) {
        // The sandbox can disappear between the GET above and this call — treat a
        // late 404 the same as an initial one so the manager spawns fresh.
        if (error instanceof E2BNotFoundError) {
          return {
            success: false,
            error: "Sandbox no longer exists in E2B",
            shouldSpawnFresh: true,
          };
        }
        throw error;
      }

      const codeServerPassword = config.codeServerEnabled
        ? await deriveCodeServerPassword(
            config.sandboxId,
            this.providerConfig.codeServerPasswordSecret
          )
        : undefined;
      const { codeServerUrl, tunnelUrls } = this.buildTunnelUrls(
        config.providerObjectId,
        config.codeServerEnabled,
        config.sandboxSettings,
        sandbox.domain
      );

      return {
        success: true,
        providerObjectId: sandbox.sandboxID,
        codeServerUrl,
        codeServerPassword,
        tunnelUrls,
      };
    } catch (error) {
      throw this.classifyError("Failed to resume E2B sandbox", error, "resume");
    }
  }

  /**
   * Idle/heartbeat stops are a resumable PAUSE (the manager routes them here via
   * supportsPersistentResume, and resumeSandbox brings the sandbox back).
   * Terminal stops (a sandbox that never connected) instead KILL: the manager
   * marks that session `failed` and won't resume it, so pausing would orphan a
   * sandbox E2B retains indefinitely.
   */
  async stopSandbox(config: StopConfig): Promise<StopResult> {
    const terminal = E2BSandboxProvider.TERMINAL_STOP_REASONS.has(config.reason);
    try {
      try {
        if (terminal) {
          await this.client.killSandbox(config.providerObjectId);
        } else {
          await this.client.pauseSandbox(config.providerObjectId);
        }
      } catch (error) {
        // Already gone or already paused — nothing to do.
        if (error instanceof E2BNotFoundError || error instanceof E2BConflictError) {
          return { success: true };
        }
        throw error;
      }
      return { success: true };
    } catch (error) {
      throw this.classifyError(
        `Failed to stop (${terminal ? "kill" : "pause"}) E2B sandbox`,
        error,
        "stop"
      );
    }
  }

  /**
   * Permanently kill a sandbox. Used to tear down the ephemeral image-build
   * sandbox once its filesystem has been snapshotted: stopSandbox only pauses
   * (correct for idle sessions) and would leak the single-use build sandbox
   * until its TTL. Idempotent — a missing sandbox is treated as already gone.
   */
  async deleteSandbox(providerObjectId: string): Promise<void> {
    try {
      await this.client.killSandbox(providerObjectId);
    } catch (error) {
      if (error instanceof E2BNotFoundError) return;
      throw this.classifyError("Failed to delete E2B sandbox", error, "stop");
    }
  }

  /**
   * Trigger an E2B environment-image build. A build sandbox boots from the base
   * template, clones every repository and runs `.openinspect/setup.sh` once (the
   * SESSION_CONFIG carries the repository list), reports completion via the
   * repo-image callback, then idles awaiting the snapshot taken by takeSnapshot.
   * The build sandbox does not auto-pause: its filesystem is snapshotted in place.
   */
  async triggerEnvironmentImageBuild(
    config: TriggerE2BEnvironmentImageBuildConfig
  ): Promise<TriggerE2BEnvironmentImageBuildResult> {
    const primary = config.repositories[0];
    if (!primary) {
      throw new Error("environment build requires at least one repository");
    }

    let sandboxId: string | undefined;
    try {
      const sandbox = await this.client.createSandbox({
        templateID: this.client.config.templateId,
        metadata: {
          openinspect_framework: "open-inspect",
          openinspect_kind: "environment-image-build",
          openinspect_build_id: config.buildId,
          openinspect_environment: config.environmentId,
        },
        timeoutSeconds: config.buildTimeoutSeconds ?? DEFAULT_BUILD_TIMEOUT_SECONDS,
        // The build sandbox must stay alive so takeSnapshot can bake its
        // filesystem; never auto-pause/resume it.
        autoPause: false,
        secure: true,
        autoResume: false,
      });
      sandboxId = sandbox.sandboxID;

      // Register the build sandbox before delivering env, so the workflow has
      // bound the provider session before the supervisor can run setup and fire
      // the build-complete callback (which is rejected until the session is bound).
      if (config.onProviderSessionCreated) {
        await config.onProviderSessionCreated(sandbox.sandboxID);
      }

      const env = this.buildBuildEnvVars({
        userEnvVars: config.userEnvVars,
        cloneToken: config.cloneToken,
        buildSandboxId: `build-env-${config.environmentId}`,
        repoOwner: primary.repoOwner,
        repoName: primary.repoName,
        sessionConfig: {
          branch: primary.baseBranch,
          repositories: config.repositories.map(toRepositoryConfigPayload),
        },
        buildId: config.buildId,
        callbackUrl: config.callbackUrl,
        failureCallbackUrl: config.failureCallbackUrl,
        callbackToken: config.callbackToken,
        providerSessionId: sandbox.sandboxID,
      });
      await this.deliverSessionEnv(sandbox, env);

      log.info("e2b.environment_image_build_triggered", {
        build_id: config.buildId,
        environment_id: config.environmentId,
        sandbox_id: sandbox.sandboxID,
      });

      return { buildId: config.buildId, status: "building" };
    } catch (error) {
      // deliverSessionEnv kills on write failure; this covers a create-time or
      // onProviderSessionCreated failure that leaves the sandbox running.
      if (sandboxId) {
        try {
          await this.client.killSandbox(sandboxId);
        } catch (killError) {
          if (!(killError instanceof E2BNotFoundError)) {
            log.warn("e2b.build_cleanup_kill_failed", {
              sandbox_id: sandboxId,
              error: killError instanceof Error ? killError.message : String(killError),
            });
          }
        }
      }
      if (error instanceof SandboxProviderError) throw error;
      throw this.classifyError("Failed to trigger E2B environment image build", error, "create");
    }
  }

  async deleteProviderImage(providerImageId: string): Promise<void> {
    try {
      await this.client.deleteTemplate(providerImageId);
    } catch (error) {
      if (error instanceof E2BNotFoundError) return;
      throw this.classifyError("Failed to delete E2B snapshot", error, "delete");
    }
  }

  /**
   * Create a runtime sandbox from `templateId` (the base template, a prebuilt
   * snapshot, or a restore snapshot) and deliver the per-session env. Shared by
   * createSandbox and restoreFromSnapshot; `extraEnv` carries the boot-mode
   * marker each path sets.
   */
  private async spawnFromTemplate(
    config: CreateSandboxConfig | RestoreConfig,
    templateId: string,
    extraEnv: Record<string, string>
  ): Promise<{
    providerObjectId: string;
    createdAt: number;
    codeServerUrl?: string;
    codeServerPassword?: string;
    tunnelUrls?: Record<string, string>;
  }> {
    const { envVars, codeServerPassword } = await this.buildRuntimeEnv(config, extraEnv);

    const sandbox = await this.client.createSandbox({
      templateID: templateId,
      metadata: this.buildMetadata(config),
      timeoutSeconds: config.timeoutSeconds ?? this.providerConfig.sandboxTimeoutSeconds,
      autoPause: this.providerConfig.autoPause,
      // Require secure envd access: the per-session env we upload carries
      // SANDBOX_AUTH_TOKEN + user secrets, so envd must reject writes lacking the
      // returned access token (otherwise the upload is anonymous over the public host).
      secure: true,
      // Deliberately NOT auto-resume: resume is control-plane-driven (resumeSandbox →
      // connectSandbox). Provider-side auto-resume would wake a paused sandbox from
      // stray inbound traffic, outside the DO state machine.
      autoResume: false,
    });

    await this.deliverSessionEnv(sandbox, envVars);

    const { codeServerUrl, tunnelUrls } = this.buildTunnelUrls(
      sandbox.sandboxID,
      config.codeServerEnabled,
      config.sandboxSettings,
      sandbox.domain
    );

    return {
      providerObjectId: sandbox.sandboxID,
      createdAt: Date.now(),
      codeServerUrl,
      codeServerPassword,
      tunnelUrls,
    };
  }

  private async buildRuntimeEnv(
    config: CreateSandboxConfig | RestoreConfig,
    extraEnv: Record<string, string>
  ): Promise<{ envVars: Record<string, string>; codeServerPassword?: string }> {
    const codeServerPassword = config.codeServerEnabled
      ? await deriveCodeServerPassword(
          config.sandboxId,
          this.providerConfig.codeServerPasswordSecret
        )
      : undefined;
    const envVars = buildSandboxEnvVars(config, {
      scmIdentity: scmCloneIdentity(this.providerConfig.scmProvider),
      codeServerPassword,
    });
    // E2B sandboxes run as a non-root user and /run is a root-owned tmpfs, so
    // the git credential helper can't create its default cache dir (/run/oi).
    envVars.OI_SCM_CRED_CACHE_DIR = "/tmp/oi";
    Object.assign(envVars, extraEnv);
    return { envVars, codeServerPassword };
  }

  private async createSnapshotResult(providerObjectId: string): Promise<SnapshotResult> {
    const snapshot = await this.client.createSnapshot(providerObjectId);
    if (!snapshot.snapshotID) {
      return { success: false, error: "E2B snapshot did not return a snapshot id" };
    }
    return { success: true, imageId: snapshot.snapshotID };
  }

  private async cleanupSandbox(sandboxId: string, event: string): Promise<void> {
    try {
      await this.client.killSandbox(sandboxId);
    } catch (error) {
      if (error instanceof E2BNotFoundError) return;
      log.warn(event, {
        sandbox_id: sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Deliver the per-session env to the supervisor via envd. E2B's template start
   * command runs once at build and never sees create-time env vars, so the
   * launcher (oi-launch.py) waits for this file and starts the supervisor with it.
   * On failure the sandbox exists but will never get its env — kill it rather
   * than leak a running launcher-only sandbox until its TTL.
   */
  private async deliverSessionEnv(
    sandbox: E2BSandboxCreated,
    envVars: Record<string, string>
  ): Promise<void> {
    try {
      const envdAccessToken = sandbox.envdAccessToken;
      if (!envdAccessToken) {
        // secure:true always returns a token, so a missing one is systemic (secure
        // unsupported / API change), not intermittent — classify permanent to trip the
        // circuit breaker rather than looping create→kill. Fail closed: the env write
        // (SANDBOX_AUTH_TOKEN + secrets) never happens; the catch below kills the sandbox.
        throw new SandboxProviderError(
          "E2B create did not return an envd access token (secure access required)",
          "permanent"
        );
      }
      await this.client.writeSessionEnv(sandbox.sandboxID, envVars, {
        domain: sandbox.domain,
        envdAccessToken,
      });
    } catch (error) {
      try {
        await this.client.killSandbox(sandbox.sandboxID);
      } catch (killError) {
        log.warn("e2b.cleanup_kill_failed", {
          sandbox_id: sandbox.sandboxID,
          error: killError instanceof Error ? killError.message : String(killError),
        });
      }
      throw error;
    }
  }

  /**
   * Build-sandbox env for environment-image builds. Unlike a runtime session,
   * the whole env (build-mode marker, SESSION_CONFIG, and the repo-image callback
   * vars) is delivered in the single session-env file oi-launch reads, because
   * E2B has no separate per-create entrypoint launch. User secrets come first;
   * any user-supplied reserved callback keys are scrubbed so they can't spoof the
   * build callback.
   */
  private buildBuildEnvVars(config: {
    userEnvVars?: Record<string, string>;
    cloneToken?: string;
    buildSandboxId: string;
    repoOwner: string;
    repoName: string;
    sessionConfig: Record<string, unknown>;
    buildId: string;
    callbackUrl: string;
    failureCallbackUrl: string;
    callbackToken: string;
    providerSessionId: string;
  }): Record<string, string> {
    const envVars: Record<string, string> = { ...(config.userEnvVars ?? {}) };
    for (const key of RESERVED_REPO_IMAGE_CALLBACK_ENV_KEYS) {
      delete envVars[key];
    }

    Object.assign(envVars, {
      PYTHONUNBUFFERED: "1",
      SANDBOX_ID: config.buildSandboxId,
      SANDBOX_VERSION: E2B_SANDBOX_VERSION,
      REPO_OWNER: config.repoOwner,
      REPO_NAME: config.repoName,
      OI_SCM_CRED_CACHE_DIR: "/tmp/oi",
      [IMAGE_BUILD_MODE_ENV_VAR]: "true",
      [SESSION_CONFIG_ENV_VAR]: JSON.stringify(config.sessionConfig),
      [REPO_IMAGE_CALLBACK_ENV_KEYS[0]]: config.providerSessionId,
      [REPO_IMAGE_CALLBACK_ENV_KEYS[1]]: config.buildId,
      [REPO_IMAGE_CALLBACK_ENV_KEYS[2]]: config.callbackUrl,
      [REPO_IMAGE_CALLBACK_ENV_KEYS[3]]: config.callbackToken,
      [REPO_IMAGE_CALLBACK_ENV_KEYS[4]]: config.failureCallbackUrl,
    });

    applyScmCloneEnv(envVars, scmCloneIdentity(this.providerConfig.scmProvider), config.cloneToken);
    return envVars;
  }

  private buildMetadata(config: CreateSandboxConfig | RestoreConfig): Record<string, string> {
    const metadata: Record<string, string> = {
      openinspect_framework: "open-inspect",
      openinspect_session_id: config.sessionId,
      openinspect_expected_sandbox_id: config.sandboxId,
    };
    // Repo-less (environment/multi-repo) sessions have no single repo to label.
    if (config.repoOwner && config.repoName) {
      metadata.openinspect_repo = `${config.repoOwner}/${config.repoName}`;
    }
    return metadata;
  }

  private buildTunnelUrls(
    e2bSandboxId: string,
    codeServerEnabled: boolean | undefined,
    sandboxSettings: SandboxSettings | undefined,
    domain?: string | null
  ) {
    let tunnelPorts = resolveTunnelPorts(sandboxSettings?.tunnelPorts);
    let codeServerUrl: string | undefined;

    if (codeServerEnabled) {
      const { codeServerPort } = resolveServicePorts(sandboxSettings);
      codeServerUrl = this.client.getHostnameForPort(e2bSandboxId, codeServerPort, domain);
      tunnelPorts = tunnelPorts.filter((p) => p !== codeServerPort);
    }

    const tunnelUrls =
      tunnelPorts.length > 0
        ? Object.fromEntries(
            tunnelPorts.map((p) => [
              String(p),
              this.client.getHostnameForPort(e2bSandboxId, p, domain),
            ])
          )
        : undefined;

    return { codeServerUrl, tunnelUrls };
  }

  private classifyError(
    message: string,
    error: unknown,
    operation: E2BOperation
  ): SandboxProviderError {
    // Already classified (e.g. the secure-access guard) — don't double-wrap and lose its message.
    if (error instanceof SandboxProviderError) return error;
    if (error instanceof E2BApiError) {
      if (error.status === 429) {
        // Rate limiting is temporary — classify transient so it isn't counted
        // toward the sandbox circuit breaker (a permanent error would open the
        // breaker and block later spawns for minutes).
        return new SandboxProviderError(
          `${message} (rate-limited during ${operation})`,
          "transient",
          error
        );
      }
      return SandboxProviderError.fromFetchError(
        `${message}: ${error.message}`,
        error,
        error.status
      );
    }
    return SandboxProviderError.fromFetchError(message, error);
  }
}

export function createE2BProvider(
  client: E2BRestClient,
  providerConfig: E2BProviderConfig
): E2BSandboxProvider {
  return new E2BSandboxProvider(client, providerConfig);
}
