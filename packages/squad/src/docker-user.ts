// Which user a container runs as. On a rootful daemon it is the host user, so the files a pass
// writes in its account folder stay ours. On a rootless daemon the container's root already maps to
// the host user, and `--user <uid>` would map to a subuid that cannot write the folder.

import { spawnSync } from "node:child_process";

export type ContainerUser = { readonly uid: number; readonly gid: number } | null;

/** True when `docker info --format '{{json .SecurityOptions}}'` names the rootless option. */
export function isRootless(securityOptions: string): boolean {
  let list: unknown;
  try {
    list = JSON.parse(securityOptions);
  } catch {
    return false;
  }
  return Array.isArray(list) && list.some((o) => typeof o === "string" && o.split(",").includes("name=rootless"));
}

export const hostUser = (): ContainerUser => (process.getuid === undefined || process.getgid === undefined ? null : { uid: process.getuid(), gid: process.getgid() });

export type DockerInfo = (docker: string) => string | null;

const realInfo: DockerInfo = (docker) => {
  const r = spawnSync(docker, ["info", "--format", "{{json .SecurityOptions}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
  return r.status === 0 ? r.stdout : null;
};

// The daemon does not change under a running process; DOCKER_HOST is part of the key in case a test
// or a caller points the same binary at another daemon.
const cache = new Map<string, ContainerUser>();

/**
 * The `--user` for every container this process starts: null on a rootless daemon, else the host
 * user. When `docker info` fails the host user stays, as before; the run itself then reports the
 * docker error.
 */
export function containerUser(docker: string, info: DockerInfo = realInfo): ContainerUser {
  const key = `${docker}\0${process.env["DOCKER_HOST"] ?? ""}`;
  const known = cache.get(key);
  if (known !== undefined && info === realInfo) return known;
  const out = info(docker);
  const user = out !== null && isRootless(out) ? null : hostUser();
  if (info === realInfo) cache.set(key, user);
  return user;
}
