# AIX Remote - SSH for IBM Bob IDE

Connect [IBM Bob IDE](https://bob.ibm.com) to AIX remote machines via SSH.

---

## SSH Host Requirements

**Supported platforms:**

- x86_64 Debian 8+, Ubuntu 16.04+, CentOS / RHEL 7+ Linux
- ARMv7l (AArch32) Raspbian Stretch/9+ (32-bit)
- ARMv8l (AArch64) Ubuntu 18.04+ (64-bit)
- macOS 10.14+ (Mojave)
- Windows 10+
- **AIX 7.1+ ppc64** ✓ fully supported

---

## Prerequisites

### On your Mac (local machine):
- **IBM Bob IDE** installed
- **SSH client** available (`ssh` command)
- **Network access** to your AIX server
- A `github.ibm.com` **personal access token** (classic, `repo` scope) — needed to download the pre-built AIX server tarball

### On your AIX server:
- **SSH server** running (`sshd`)
- **Node.js 22.x** installed at `/opt/nodejs/bin/node`
- **GNU tar** at `/opt/freeware/bin/gtar`
- **curl** at `/opt/freeware/bin/curl`
- User account with write access to `$HOME`

---

## Installation

1. Download the latest `.vsix` from [Releases](https://github.ibm.com/Himadhith-V/bob-remote-ssh/releases)
2. In Bob IDE: **Extensions** → `...` menu → **Install from VSIX...**
3. Select the downloaded `.vsix` file

---

## Configuration

### 1. Set your github.ibm.com token

The extension downloads a pre-built AIX server tarball from `github.ibm.com`. Set your token so it can authenticate:

1. Open **Settings** (`Cmd+,`)
2. Search for `aixServerGithubToken`
3. Paste your [github.ibm.com personal access token](https://github.ibm.com/settings/tokens) (classic, `repo` scope)

### 2. Configure SSH

Create or edit `~/.ssh/config`:
```
Host aix-server
    HostName your-aix-server.ibm.com
    User your-username
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 60
    TCPKeepAlive yes
```

---

## Connecting

1. Open **Command Palette** (`Cmd+Shift+P`)
2. Run **Remote-SSH: Connect to Host...**
3. Enter `username@your-aix-server.ibm.com` or your SSH config alias
4. Bob IDE will automatically:
   - Detect AIX
   - Download the pre-built AIX server tarball from `github.ibm.com/Himadhith-V/bob-ide-aix-server`
   - Extract and start the server
   - Open a remote workspace

First connection takes ~30 seconds to download and install the server (~150MB). Subsequent connections are instant.

---

## Verify

Once connected:
- Bottom-left corner shows: `SSH: your-aix-server`
- Open a terminal: **Terminal → New Terminal**
- Run `uname -a` — should show `AIX`

---

## Log files

- **Bob IDE logs**: Help → Toggle Developer Tools → Console
- **Remote server logs**: `~/.bobide-server/.<commit>.log` on the AIX machine
- **SSH debug**: `ssh -v username@hostname`

---

## Reporting issues

[Report issues here](https://github.ibm.com/Himadhith-V/bob-remote-ssh/issues)

Include:
1. AIX version: `oslevel -s`
2. Node.js version: `/opt/nodejs/bin/node --version`
3. Bob IDE version: Help → About
4. Extension version: Extensions panel
5. Error logs from locations above

---

## FAQ

### Q: Why do I need a github.ibm.com token?
**A:** The pre-built AIX server tarball is hosted on `github.ibm.com`. Even though the repo is public, GHE requires authentication to download release assets directly.

### Q: What if my AIX server uses a different Node.js path?
**A:** Create a symlink:
```bash
sudo mkdir -p /opt/nodejs/bin
sudo ln -s /your/nodejs/path/node /opt/nodejs/bin/node
```

### Q: How do I update for a new Bob IDE version?
**A:** When Bob IDE updates, the extension will fall back to a Linux x64 server (terminals won't work) until a new AIX tarball is built and published to `github.ibm.com/Himadhith-V/bob-ide-aix-server`. To build a new tarball, see that repo's README.

---

## Acknowledgements

Based on [jeanp413/open-remote-ssh](https://github.com/jeanp413/open-remote-ssh) with AIX ppc64 support added.
Pre-built AIX server tarballs: [Himadhith-V/bob-ide-aix-server](https://github.ibm.com/Himadhith-V/bob-ide-aix-server).
