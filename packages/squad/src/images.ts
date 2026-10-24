// The one version table for the runner images. A Dockerfile in images/ takes its pins as build args,
// so a bump is one edit here. Nothing else holds a CLI version or an image tag.

export type ImageRunner = "pi" | "codex" | "claude";

/** The base image, pinned by digest so a rebuild gets the same OS layer. */
export const NODE_IMAGE = "node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d";

export interface ImageSpec {
  readonly version: string;
  readonly tag: string;
}

const spec = (runner: ImageRunner, version: string): ImageSpec => ({ version, tag: `squad-${runner}:${version}` });

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
    "--build-arg", `${runner.toUpperCase()}_VERSION=${version}`,
    "-t", tag,
    "images",
  ];
}
