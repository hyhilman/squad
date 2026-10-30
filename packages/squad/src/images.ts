// The one version table for the runner images. A Dockerfile in images/ takes its pins as build args,
// so a bump is one edit here. Nothing else holds a CLI version or an image tag.

export type ImageRunner = "pi" | "codex" | "claude";

/** The base image, pinned by digest so a rebuild gets the same OS layer. */
export const NODE_IMAGE = "node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d";

/** uv, which installs Python and runs a project's Python tools. Pinned by tag and digest. */
export const UV_IMAGE = "ghcr.io/astral-sh/uv:0.9.30@sha256:538e0b39736e7feae937a65983e49d2ab75e1559d35041f9878b7b7e51de91e4";

/** The Python that uv installs in every image. An exact patch, so a rebuild gets the same one. */
export const PYTHON_VERSION = "3.12.12";

/**
 * Bump this when the images change but no CLI version does (a new tool, a new base). It is in the tag,
 * so a host that holds the old image finds no image at the new tag and must build it, instead of
 * running the old one without a word.
 */
export const IMAGE_REVISION = 2;

export interface ImageSpec {
  readonly version: string;
  readonly tag: string;
}

const spec = (runner: ImageRunner, version: string): ImageSpec => ({ version, tag: `squad-${runner}:${version}-r${IMAGE_REVISION}` });

export const IMAGES: Readonly<Record<ImageRunner, ImageSpec>> = {
  pi: spec("pi", "1.1.0"),
  codex: spec("codex", "0.162.1"),
  claude: spec("claude", "2.1.310"),
};

/** The `docker build` argv (after `docker`). Run it from the repo root: the build context is images/. */
export function buildArgv(runner: ImageRunner): string[] {
  const { version, tag } = IMAGES[runner];
  return [
    "build", "-f", `images/${runner}/Dockerfile`,
    "--build-arg", `NODE_IMAGE=${NODE_IMAGE}`,
    "--build-arg", `UV_IMAGE=${UV_IMAGE}`,
    "--build-arg", `PYTHON_VERSION=${PYTHON_VERSION}`,
    "--build-arg", `${runner.toUpperCase()}_VERSION=${version}`,
    "-t", tag,
    "images",
  ];
}
