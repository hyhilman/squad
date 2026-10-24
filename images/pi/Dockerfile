# The pi runner image. It holds the toolchain only: node, git, gh, ripgrep, flock and a pinned pi.
# No application code and no credentials. A pass mounts the worktree and one account folder.
#
# The build context is images/, so every runner can COPY the shared entry.sh.
#
# The container runs as the host uid:gid (`docker run --user`), so files written into the worktree
# are yours. No uid is baked in, so HOME is a world-writable dir.

ARG NODE_IMAGE
FROM ${NODE_IMAGE}

# util-linux is for flock: the account lock is taken inside the container (see entry.sh).
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    procps \
    ripgrep \
    util-linux \
  && rm -rf /var/lib/apt/lists/*

# gh from GitHub's own apt repo: Debian's bookworm package is too old for current `gh pr` flags.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# A pinned version, never `latest`. The pin lives in packages/squad/src/images.ts.
ARG PI_VERSION
RUN test -n "$PI_VERSION" \
  && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
  && npm cache clean --force

# /pi is the one mounted account folder. /gh is the GitHub login, mounted read-only. /squad holds the
# lock and the token file, mounted per pass.
RUN mkdir -p /home/pi /pi /gh /squad /work && chmod 1777 /home/pi /pi /work
ENV HOME=/home/pi \
    PI_CODING_AGENT_DIR=/pi \
    GH_CONFIG_DIR=/gh \
    GIT_SSH_COMMAND=/bin/false

# gh holds the token at $GH_CONFIG_DIR (mounted per pass); this is what git asks for it.
COPY pi/gitconfig /etc/gitconfig
COPY entry.sh /usr/local/bin/squad-entry

WORKDIR /work
# The caller images built FROM this one are checked for this label (see turn.ts checkImage): the account lock lives in squad-entry.
LABEL squad.entry="1"
ENTRYPOINT ["squad-entry", "pi"]
