import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const IMAGE_REPOSITORY = "wingman-sandbox";
const MAX_OUTPUT = 1024 * 1024;

/** Require a working Docker CLI and an accessible daemon before startup. */
export async function checkDocker(): Promise<void> {
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 10_000,
      maxBuffer: MAX_OUTPUT,
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "Docker CLI was not found. Install Docker and ensure it is on PATH before starting Wingman.",
        { cause },
      );
    }
    throw new Error(
      "Docker daemon is unavailable. Start Docker and ensure Wingman can access it before starting.",
      { cause },
    );
  }
}

/** Build and pin the sandbox image so concurrent builds cannot change it. */
export async function buildSandboxImage(dockerfileDir: string): Promise<string> {
  let imageId: string;
  // Build under a unique tag so concurrent runtimes cannot change the image being inspected.
  const buildTag = `${IMAGE_REPOSITORY}:build-${randomUUID()}`;
  try {
    await execFileAsync("docker", ["build", "--tag", buildTag, dockerfileDir], {
      timeout: 180_000,
      maxBuffer: MAX_OUTPUT,
    });
    const image = await execFileAsync(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", buildTag],
      { timeout: 10_000 },
    );
    imageId = image.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
      throw new Error("Docker did not return an image ID");
    // Keep each distinct image referenced even when another runtime builds a newer one.
    await execFileAsync(
      "docker",
      ["image", "tag", imageId, `${IMAGE_REPOSITORY}:sha256-${imageId.slice(7)}`],
      { timeout: 10_000 },
    );
  } finally {
    await execFileAsync("docker", ["image", "rm", buildTag], { timeout: 10_000 }).catch(() => {});
  }
  return imageId;
}

/** Create or recover the bridge owned by a single sandbox generation. */
export async function sandboxNetwork(owner: string): Promise<string> {
  const name = `wingman-sandbox-${owner}`;
  try {
    await execFileAsync(
      "docker",
      ["network", "create", "--driver", "bridge", "--label", `io.wingman.owner=${owner}`, name],
      { timeout: 30_000 },
    );
  } catch (error) {
    const failure = error as { stderr?: string };
    if (!failure.stderr?.includes("already exists")) throw error;
  }
  const { stdout } = await execFileAsync("docker", ["network", "inspect", name], {
    timeout: 10_000,
    maxBuffer: MAX_OUTPUT,
  });
  const network = JSON.parse(stdout)[0] as {
    Id: string;
    Driver: string;
    Labels: Record<string, string>;
  };
  if (
    !/^[a-f0-9]{64}$/.test(network.Id) ||
    network.Driver !== "bridge" ||
    network.Labels?.["io.wingman.owner"] !== owner
  )
    throw new Error("Sandbox network identity does not match its ownership record");
  return network.Id;
}

/** Remove only the network labelled for this sandbox generation. */
export async function removeSandboxNetwork(owner: string): Promise<void> {
  const name = `wingman-sandbox-${owner}`;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("docker", ["network", "inspect", name], {
      timeout: 10_000,
      maxBuffer: MAX_OUTPUT,
    }));
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    if (failure.code === 1 && failure.stderr?.includes("not found")) return;
    throw error;
  }
  const network = JSON.parse(stdout)[0] as { Id: string; Labels: Record<string, string> };
  if (!/^[a-f0-9]{64}$/.test(network.Id) || network.Labels?.["io.wingman.owner"] !== owner)
    throw new Error("Sandbox network identity does not match its ownership record");
  await execFileAsync("docker", ["network", "rm", network.Id], { timeout: 30_000 });
}
