import * as crypto from 'crypto';
import * as vscode from 'vscode';
import Log from './common/logger';
import { getVSCodeServerConfig } from './serverConfig';
import SSHConnection from './ssh/sshConnection';

export interface ServerInstallOptions {
    id: string;
    quality: string;
    commit: string;
    version: string;      // full version string from product.json (e.g. "1.126.0+bob2.1.0")
    release?: string;
    extensionIds: string[];
    envVariables: string[];
    useSocketPath: boolean;
    serverApplicationName: string;
    serverDataFolderName: string;
    serverDownloadUrlTemplate: string;
    aixGithubToken?: string;
}

export interface ServerInstallResult {
    exitCode: number;
    listeningOn: number | string;
    connectionToken: string;
    logFile: string;
    osReleaseId: string;
    arch: string;
    platform: string;
    tmpDir: string;
    [key: string]: any;
}

export class ServerInstallError extends Error {
    constructor(message: string) {
        super(message);
    }
}

// Fallback used only when product.json has no serverDownloadUrlTemplate
const DEFAULT_DOWNLOAD_URL_TEMPLATE =
    'https://update.code.visualstudio.com/commit:${commit}/server-${os}-${arch}/stable';


export async function installCodeServer(conn: SSHConnection, serverDownloadUrlTemplate: string | undefined, extensionIds: string[], envVariables: string[], platform: string | undefined, useSocketPath: boolean, logger: Log): Promise<ServerInstallResult> {
    let shell = 'powershell';

    // detect platform and shell for windows
    if (!platform || platform === 'windows') {
        const result = await conn.exec('uname -s');

        if (result.stdout) {
            if (result.stdout.includes('windows32')) {
                platform = 'windows';
            } else if (result.stdout.includes('MINGW64')) {
                platform = 'windows';
                shell = 'bash';
            }
        } else if (result.stderr) {
            if (result.stderr.includes('FullyQualifiedErrorId : CommandNotFoundException')) {
                platform = 'windows';
            }

            if (result.stderr.includes('is not recognized as an internal or external command')) {
                platform = 'windows';
                shell = 'cmd';
            }
        }

        if (platform) {
            logger.trace(`Detected platform: ${platform}, ${shell}`);
        }
    }

    const scriptId = crypto.randomBytes(12).toString('hex');

    const vscodeServerConfig = await getVSCodeServerConfig();

    const effectiveTemplate =
        serverDownloadUrlTemplate ||
        vscodeServerConfig.serverDownloadUrlTemplate ||
        DEFAULT_DOWNLOAD_URL_TEMPLATE;

    logger.trace(`serverDownloadUrlTemplate: ${effectiveTemplate}`);

    const aixGithubToken = vscode.workspace.getConfiguration('remote.SSH').get<string>('aixServerGithubToken', '');

    const installOptions: ServerInstallOptions = {
        id: scriptId,
        version: vscodeServerConfig.version,   // full string e.g. "1.126.0+bob2.1.0"
        commit: vscodeServerConfig.commit,
        quality: vscodeServerConfig.quality,
        release: vscodeServerConfig.release,
        extensionIds,
        envVariables,
        useSocketPath,
        serverApplicationName: vscodeServerConfig.serverApplicationName,
        serverDataFolderName: vscodeServerConfig.serverDataFolderName,
        serverDownloadUrlTemplate: effectiveTemplate,
        aixGithubToken,
    };

    let commandOutput: { stdout: string; stderr: string };
    if (platform === 'windows') {
        const installServerScript = generatePowerShellInstallScript(installOptions);

        logger.trace('Server install command:', installServerScript);

        const installDir = `$HOME\\${vscodeServerConfig.serverDataFolderName}\\install`;
        const installScript = `${installDir}\\${vscodeServerConfig.commit}.ps1`;
        const endRegex = new RegExp(`${scriptId}: end`);
        // investigate if it's possible to use `-EncodedCommand` flag
        // https://devblogs.microsoft.com/powershell/invoking-powershell-with-complex-expressions-using-scriptblocks/
        let command = '';
        if (shell === 'powershell') {
            command = `md -Force ${installDir}; echo @'\n${installServerScript}\n'@ | Set-Content ${installScript}; powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'bash') {
            command = `mkdir -p ${installDir.replace(/\\/g, '/')} && echo '\n${installServerScript.replace(/'/g, '\'"\'"\'')}\n' > ${installScript.replace(/\\/g, '/')} && powershell -ExecutionPolicy ByPass -File "${installScript}"`;
        } else if (shell === 'cmd') {
            const script = installServerScript.trim()
                // remove comments
                .replace(/^#.*$/gm, '')
                // remove empty lines
                .replace(/\n{2,}/gm, '\n')
                // remove leading spaces
                .replace(/^\s*/gm, '')
                // escape double quotes (from powershell/cmd)
                .replace(/"/g, '"""')
                // escape single quotes (from cmd)
                .replace(/'/g, `''`)
                // escape redirect (from cmd)
                .replace(/>/g, `^>`)
                // escape new lines (from powershell/cmd)
                .replace(/\n/g, '\'`n\'');

            command = `powershell "md -Force ${installDir}" && powershell "echo '${script}'" > ${installScript.replace('$HOME', '%USERPROFILE%')} && powershell -ExecutionPolicy ByPass -File "${installScript.replace('$HOME', '%USERPROFILE%')}"`;

            logger.trace('Command length (8191 max):', command.length);

            if (command.length > 8191) {
                throw new ServerInstallError(`Command line too long`);
            }
        } else {
            throw new ServerInstallError(`Not supported shell: ${shell}`);
        }

        commandOutput = await conn.execPartial(command, (stdout: string) => endRegex.test(stdout));
    } else {
        const installServerScript = generateBashInstallScript(installOptions);

        logger.trace('Server install command:', installServerScript);
        // Fish shell does not support heredoc so let's workaround it using -c option,
        // also replace single quotes (') within the script with ('\'') as there's no quoting within single quotes, see https://unix.stackexchange.com/a/24676
        commandOutput = await conn.exec(`bash -c '${installServerScript.replace(/'/g, `'\\''`)}'`);
    }

    if (commandOutput.stderr) {
        logger.trace('Server install command stderr:', commandOutput.stderr);
    }
    logger.trace('Server install command stdout:', commandOutput.stdout);

    const resultMap = parseServerInstallOutput(commandOutput.stdout, scriptId);
    if (!resultMap) {
        throw new ServerInstallError(`Failed parsing install script output`);
    }

    const exitCode = parseInt(resultMap.exitCode, 10);
    if (exitCode !== 0) {
        throw new ServerInstallError(`Couldn't install vscode server on remote server, install script returned non-zero exit status`);
    }

    const listeningOn = resultMap.listeningOn.match(/^\d+$/)
        ? parseInt(resultMap.listeningOn, 10)
        : resultMap.listeningOn;

    const remoteEnvVars = Object.fromEntries(Object.entries(resultMap).filter(([key,]) => envVariables.includes(key)));

    return {
        exitCode,
        listeningOn,
        connectionToken: resultMap.connectionToken,
        logFile: resultMap.logFile,
        osReleaseId: resultMap.osReleaseId,
        arch: resultMap.arch,
        platform: resultMap.platform,
        tmpDir: resultMap.tmpDir,
        ...remoteEnvVars
    };
}

function parseServerInstallOutput(str: string, scriptId: string): { [k: string]: string } | undefined {
    const startResultStr = `${scriptId}: start`;
    const endResultStr = `${scriptId}: end`;

    const startResultIdx = str.indexOf(startResultStr);
    if (startResultIdx < 0) {
        return undefined;
    }

    const endResultIdx = str.indexOf(endResultStr, startResultIdx + startResultStr.length);
    if (endResultIdx < 0) {
        return undefined;
    }

    const installResult = str.substring(startResultIdx + startResultStr.length, endResultIdx);

    const resultMap: { [k: string]: string } = {};
    const resultArr = installResult.split(/\r?\n/);
    for (const line of resultArr) {
        const [key, value] = line.split('==');
        resultMap[key] = value;
    }

    return resultMap;
}

function generateBashInstallScript({
    id,
    quality,
    version,
    commit,
    release,
    extensionIds,
    envVariables,
    useSocketPath,
    serverApplicationName,
    serverDataFolderName,
    serverDownloadUrlTemplate,
    aixGithubToken,
}: ServerInstallOptions) {
    const extensions = extensionIds.map(id => '--install-extension ' + id).join(' ');

    return `
# Server installation script

TMP_DIR="\${XDG_RUNTIME_DIR:-"/tmp"}"

DISTRO_VERSION="${version}"
DISTRO_COMMIT="${commit}"
DISTRO_QUALITY="${quality}"
DISTRO_RELEASE="${release ?? ''}"
AIX_GITHUB_TOKEN="${aixGithubToken ?? ''}"

SERVER_APP_NAME="${serverApplicationName}"
SERVER_INITIAL_EXTENSIONS="${extensions}"
SERVER_LISTEN_FLAG="${useSocketPath ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"` : '--port=0'}"
SERVER_DATA_DIR="$HOME/${serverDataFolderName}"
SERVER_DIR="$SERVER_DATA_DIR/bin/$DISTRO_COMMIT"
SERVER_SCRIPT="$SERVER_DIR/bin/$SERVER_APP_NAME"
SERVER_LOGFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.log"
SERVER_PIDFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.pid"
SERVER_TOKENFILE="$SERVER_DATA_DIR/.$DISTRO_COMMIT.token"
SERVER_ARCH=
SERVER_CONNECTION_TOKEN=
SERVER_DOWNLOAD_URL=

LISTENING_ON=
OS_RELEASE_ID=
ARCH=
PLATFORM=

# Mimic output from logs of remote-ssh extension
print_install_results_and_exit() {
    echo "${id}: start"
    echo "exitCode==$1=="
    echo "listeningOn==$LISTENING_ON=="
    echo "connectionToken==$SERVER_CONNECTION_TOKEN=="
    echo "logFile==$SERVER_LOGFILE=="
    echo "osReleaseId==$OS_RELEASE_ID=="
    echo "arch==$ARCH=="
    echo "platform==$PLATFORM=="
    echo "tmpDir==$TMP_DIR=="
    ${envVariables.map(envVar => `echo "${envVar}==$${envVar}=="`).join('\n')}
    echo "${id}: end"
    exit 0
}

# Check if platform is supported
KERNEL="$(uname -s)"
case $KERNEL in
    Darwin)
        PLATFORM="darwin"
        ;;
    Linux)
        PLATFORM="linux"
        ;;
    FreeBSD)
        PLATFORM="freebsd"
        ;;
    DragonFly)
        PLATFORM="dragonfly"
        ;;
    AIX)
        PLATFORM="aix"
        ;;
    *)
        echo "Error platform not supported: $KERNEL"
        print_install_results_and_exit 1
        ;;
esac

# Check machine architecture
ARCH="$(uname -m)"
case $ARCH in
    x86_64 | amd64)
        SERVER_ARCH="x64"
        ;;
    armv7l | armv8l)
        SERVER_ARCH="armhf"
        ;;
    arm64 | aarch64)
        SERVER_ARCH="arm64"
        ;;
    ppc64le)
        SERVER_ARCH="ppc64le"
        ;;
    ppc64|powerpc64)
        SERVER_ARCH="ppc64"
        ;;
    riscv64)
        SERVER_ARCH="riscv64"
        ;;
    loongarch64)
        SERVER_ARCH="loong64"
        ;;
    s390x)
        SERVER_ARCH="s390x"
        ;;
    *)
        # Handle AIX special case where uname -m returns machine ID
        if [[ $PLATFORM == "aix" ]]; then
            AIX_ARCH="$(uname -p 2>/dev/null)"
            case $AIX_ARCH in
                powerpc)
                    SERVER_ARCH="ppc64"
                    ARCH="ppc64"
                    ;;
                *)
                    echo "Error AIX architecture not supported: $AIX_ARCH"
                    print_install_results_and_exit 1
                    ;;
            esac
        else
            echo "Error architecture not supported: $ARCH"
            print_install_results_and_exit 1
        fi
        ;;
esac

# Add freeware path for AIX
if [[ $PLATFORM == "aix" ]]; then
    export PATH="/opt/freeware/bin:$PATH"
fi

# Handle OS release detection
if [[ $PLATFORM == "aix" ]]; then
    OS_RELEASE_ID="aix"
else
    OS_RELEASE_ID="$(grep -i '^ID=' /etc/os-release 2>/dev/null | sed 's/^[Ii][Dd]=//' | sed 's/"//g')"
    if [[ -z $OS_RELEASE_ID ]]; then
        OS_RELEASE_ID="$(grep -i '^ID=' /usr/lib/os-release 2>/dev/null | sed 's/^[Ii][Dd]=//' | sed 's/"//g')"
        if [[ -z $OS_RELEASE_ID ]]; then
            OS_RELEASE_ID="unknown"
        fi
    fi
fi

# Create installation folder
if [[ ! -d $SERVER_DIR ]]; then
    mkdir -p $SERVER_DIR
    if (( $? > 0 )); then
        echo "Error creating server install directory"
        print_install_results_and_exit 1
    fi
fi

# adjust platform for vscodium download, if needed
if [[ $OS_RELEASE_ID = alpine ]]; then
    PLATFORM=$OS_RELEASE_ID
fi

# Build server download URL
# For AIX: try to fetch a pre-built patched tarball from the bob-ide-aix-server
# releases repo first. If no matching release exists yet, fall back to the Linux
# x64 REH tarball and write a Node.js wrapper at install time.
AIX_PREBUILT_URL=""
if [[ $PLATFORM == "aix" ]]; then
    AIX_BASE_VERSION=$(echo "$DISTRO_VERSION" | sed 's/+.*//' | tr -dc 0-9.)
    # Use the GHE API assets endpoint — requires token auth + Accept: application/octet-stream
    # Browser download URLs on GHE redirect to login page even for public repos
    if [[ -n "$AIX_BASE_VERSION" ]] && [[ -n "$AIX_GITHUB_TOKEN" ]]; then
        AIX_RELEASES_API="https://github.ibm.com/api/v3/repos/Himadhith-V/bob-ide-aix-server/releases/tags/v\${AIX_BASE_VERSION}"
        AIX_ASSET_API_URL=$(curl --silent --connect-timeout 15 \
            -H "Authorization: token \${AIX_GITHUB_TOKEN}" \
            "\${AIX_RELEASES_API}" \
            | python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for a in d.get('assets',[]):
    n=a.get('name','')
    if n.startswith('bob-ide-reh-aix-ppc64') and n.endswith('.tar.gz'):
        print(a['url'])
        break
" 2>/dev/null)
        if [[ -n "\${AIX_ASSET_API_URL}" ]]; then
            AIX_PREBUILT_URL="\${AIX_ASSET_API_URL}"
            echo "Found pre-built AIX server asset: \${AIX_PREBUILT_URL}"
        else
            echo "No pre-built AIX server found for \${AIX_BASE_VERSION}, using Linux x64 fallback"
        fi
    else
        echo "No AIX GitHub token set or version parse failed, using Linux x64 fallback"
    fi
    SERVER_DOWNLOAD_URL="$(echo "${serverDownloadUrlTemplate.replace(/\$\{/g, '\\${')}" \
        | sed "s/\\\${quality}/$DISTRO_QUALITY/g" \
        | sed "s/\\\${version}/$DISTRO_VERSION/g" \
        | sed "s/\\\${commit}/$DISTRO_COMMIT/g" \
        | sed "s/\\\${os}/linux/g" \
        | sed "s/\\\${arch}/x64/g" \
        | sed "s/\\\${release}/$DISTRO_RELEASE/g")"
else
    SERVER_DOWNLOAD_URL="$(echo "${serverDownloadUrlTemplate.replace(/\$\{/g, '\\${')}" \
        | sed "s/\\\${quality}/$DISTRO_QUALITY/g" \
        | sed "s/\\\${version}/$DISTRO_VERSION/g" \
        | sed "s/\\\${commit}/$DISTRO_COMMIT/g" \
        | sed "s/\\\${os}/$PLATFORM/g" \
        | sed "s/\\\${arch}/$SERVER_ARCH/g" \
        | sed "s/\\\${release}/$DISTRO_RELEASE/g")"
fi

# Check if server script is already installed
if [[ ! -f $SERVER_SCRIPT ]]; then
    case "$PLATFORM" in
        darwin | linux | alpine | aix )
            ;;
        *)
            echo "Error '$PLATFORM' needs manual installation of remote extension host"
            print_install_results_and_exit 1
            ;;
    esac

    pushd $SERVER_DIR > /dev/null || {
        echo "Error: Failed to enter server directory $SERVER_DIR"
        print_install_results_and_exit 1
    }

    # Download the server tarball
    DOWNLOAD_URL="$SERVER_DOWNLOAD_URL"
    STRIP_COMPONENTS=1
    if [[ $PLATFORM == "aix" ]] && [[ -n "$AIX_PREBUILT_URL" ]]; then
        # Pre-built AIX tarball: top-level dir is the commit hash, strip it.
        DOWNLOAD_URL="$AIX_PREBUILT_URL"
        STRIP_COMPONENTS=1
    fi

    if command -v curl >/dev/null 2>&1; then
        if [[ -n "$AIX_GITHUB_TOKEN" ]] && [[ "$DOWNLOAD_URL" == *"github.ibm.com/api"* ]]; then
            # GHE API asset download: requires token + Accept: application/octet-stream
            curl --retry 3 --connect-timeout 60 --max-time 300 --location --show-error \
                -H "Authorization: token $AIX_GITHUB_TOKEN" \
                -H "Accept: application/octet-stream" \
                --output vscode-server.tar.gz "$DOWNLOAD_URL"
        else
            curl --retry 3 --connect-timeout 60 --max-time 300 --location --show-error \
                --output vscode-server.tar.gz "$DOWNLOAD_URL"
        fi
        DOWNLOAD_EXIT=$?
    elif command -v wget >/dev/null 2>&1; then
        wget --tries=3 --timeout=60 --no-verbose -O vscode-server.tar.gz "$DOWNLOAD_URL"
        DOWNLOAD_EXIT=$?
    else
        echo "Error: curl or wget is required to download the server"
        print_install_results_and_exit 1
    fi

    if (( DOWNLOAD_EXIT > 0 )); then
        echo "Error downloading server from $DOWNLOAD_URL (exit $DOWNLOAD_EXIT)"
        print_install_results_and_exit 1
    fi

    # Verify the downloaded file is a valid gzip
    if [[ $PLATFORM == "aix" ]]; then
        if ! /opt/freeware/bin/gtar -tzf vscode-server.tar.gz >/dev/null 2>&1; then
            echo "Error: downloaded file is not a valid gzip archive"
            rm -f vscode-server.tar.gz
            print_install_results_and_exit 1
        fi
    fi

    echo "Extracting server package..."
    if [[ $PLATFORM == "aix" ]]; then
        TAR_CMD="/opt/freeware/bin/gtar"
    else
        TAR_CMD="tar"
    fi
    if ! $TAR_CMD -xzf vscode-server.tar.gz --strip-components $STRIP_COMPONENTS; then
        echo "Error while extracting server contents"
        print_install_results_and_exit 1
    fi
    rm -f vscode-server.tar.gz

    if [[ $PLATFORM == "aix" ]]; then
        # Write an AIX Node.js wrapper over the Linux server binary.
        # For pre-built tarballs this is already a shell script; for the Linux
        # x64 fallback it replaces the ELF binary so AIX Node.js is used.
        NODE_BIN="/opt/nodejs/bin/node"
        [[ -x "$NODE_BIN" ]] && echo "Node.js: $($NODE_BIN --version)"
        mkdir -p "$SERVER_DIR/bin"
        printf '#!/bin/bash\nNODE_BIN=/opt/nodejs/bin/node\n[[ ! -x $NODE_BIN ]] && echo "ERROR: node not found" >&2 && exit 1\nD=$(cd $(dirname $0) && pwd)\nfor f in $D/../out/server-main.js $D/../out/vs/server/main.js; do [[ -f $f ]] && exec $NODE_BIN $f "$@"; done\necho "ERROR: server entry not found" >&2 && exit 1\n' > "$SERVER_SCRIPT"
        chmod +x "$SERVER_SCRIPT"
        echo "AIX Node.js wrapper written to $SERVER_SCRIPT"
    fi

    if [[ ! -f $SERVER_SCRIPT ]]; then
        echo "Error server contents are corrupted"
        print_install_results_and_exit 1
    fi

    popd > /dev/null
fi

BASHRC="$HOME/.bashrc"
SNIPPET_MARKER="# === Bob IDE remote-cli PATH setup ==="
if [ ! -f "$BASHRC" ]; then
  touch "$BASHRC"
fi
if ! grep -Fq "$SNIPPET_MARKER" "$BASHRC"; then
  cat >> "$BASHRC" <<'EOF'

# === Bob IDE remote-cli PATH setup ===
if [ -d "$HOME/.bob-ide-server/bin" ]; then
  for dir in "$HOME"/.bob-ide-server/bin/*/bin/remote-cli; do
      [ -d "$dir" ] && PATH="$PATH:$dir"
  done
  export PATH
fi
# === End Bob IDE remote-cli PATH setup ===

EOF
  echo "remote-cli PATH snippet added to $BASHRC"
else
  echo "Snippet already present in $BASHRC, not adding again."
fi

# Try to find if server is already running
if [[ -f $SERVER_PIDFILE ]]; then
    SERVER_PID="$(cat $SERVER_PIDFILE)"
    if [[ $PLATFORM == "aix" ]]; then
        # AIX ps truncates the args column so grepping the full path is unreliable.
        # Use kill -0 to check if the PID is still alive instead.
        if kill -0 "$SERVER_PID" 2>/dev/null; then
            SERVER_RUNNING_PROCESS="$SERVER_PID"
        fi
    else
        SERVER_RUNNING_PROCESS="$(ps -o pid,args -p $SERVER_PID | grep $SERVER_SCRIPT)"
    fi
else
    SERVER_RUNNING_PROCESS="$(ps -o pid,args -A | grep $SERVER_SCRIPT | grep -v grep)"
fi

if [[ -z $SERVER_RUNNING_PROCESS ]]; then
    if [[ -f $SERVER_LOGFILE ]]; then
        rm $SERVER_LOGFILE
    fi
    if [[ -f $SERVER_TOKENFILE ]]; then
        rm $SERVER_TOKENFILE
    fi

    touch $SERVER_TOKENFILE
    chmod 600 $SERVER_TOKENFILE
    SERVER_CONNECTION_TOKEN="${crypto.randomUUID()}"
    echo $SERVER_CONNECTION_TOKEN > $SERVER_TOKENFILE

    $SERVER_SCRIPT --start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file $SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms &> $SERVER_LOGFILE &
    echo $! > $SERVER_PIDFILE
else
    echo "Server script is already running $SERVER_SCRIPT"
fi

if [[ -f $SERVER_TOKENFILE ]]; then
    SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"
else
    echo "Error server token file not found $SERVER_TOKENFILE"
    print_install_results_and_exit 1
fi

if [[ -f $SERVER_LOGFILE ]]; then
    for i in {1..5}; do
        LISTENING_ON="$(cat $SERVER_LOGFILE | grep -E 'Extension host agent listening on .+' | sed 's/Extension host agent listening on //')"
        if [[ -n $LISTENING_ON ]]; then
            break
        fi
        sleep 0.5
    done

    if [[ -z $LISTENING_ON ]]; then
        echo "Error server did not start successfully"
        print_install_results_and_exit 1
    fi
else
    echo "Error server log file not found $SERVER_LOGFILE"
    print_install_results_and_exit 1
fi

# Finish server setup
print_install_results_and_exit 0
`;
}

function generatePowerShellInstallScript({ id, quality, version, commit, release, extensionIds, envVariables, useSocketPath, serverApplicationName, serverDataFolderName, serverDownloadUrlTemplate }: ServerInstallOptions) {
    const extensions = extensionIds.map(id => '--install-extension ' + id).join(' ');
    const downloadUrl = serverDownloadUrlTemplate
        .replace(/\$\{quality\}/g, quality)
        .replace(/\$\{version\}/g, version)
        .replace(/\$\{commit\}/g, commit)
        .replace(/\$\{os\}/g, 'win32')
        .replace(/\$\{arch\}/g, 'x64')
        .replace(/\$\{release\}/g, release ?? '');

    return `
# Server installation script

$TMP_DIR="$env:TEMP\\$([System.IO.Path]::GetRandomFileName())"
$ProgressPreference = "SilentlyContinue"

$DISTRO_VERSION="${version}"
$DISTRO_COMMIT="${commit}"
$DISTRO_QUALITY="${quality}"
$DISTRO_VSCODIUM_RELEASE="${release ?? ''}"

$SERVER_APP_NAME="${serverApplicationName}"
$SERVER_INITIAL_EXTENSIONS="${extensions}"
$SERVER_LISTEN_FLAG="${useSocketPath ? `--socket-path="$TMP_DIR/vscode-server-sock-${crypto.randomUUID()}"` : '--port=0'}"
$SERVER_DATA_DIR="$(Resolve-Path ~)\\${serverDataFolderName}"
$SERVER_DIR="$SERVER_DATA_DIR\\bin\\$DISTRO_COMMIT"
$SERVER_SCRIPT="$SERVER_DIR\\bin\\$SERVER_APP_NAME.cmd"
$SERVER_LOGFILE="$SERVER_DATA_DIR\\.$DISTRO_COMMIT.log"
$SERVER_PIDFILE="$SERVER_DATA_DIR\\.$DISTRO_COMMIT.pid"
$SERVER_TOKENFILE="$SERVER_DATA_DIR\\.$DISTRO_COMMIT.token"
$SERVER_ARCH=
$SERVER_CONNECTION_TOKEN=
$SERVER_DOWNLOAD_URL=

$LISTENING_ON=
$OS_RELEASE_ID=
$ARCH=
$PLATFORM="win32"

function printInstallResults($code) {
    "${id}: start"
    "exitCode==$code=="
    "listeningOn==$LISTENING_ON=="
    "connectionToken==$SERVER_CONNECTION_TOKEN=="
    "logFile==$SERVER_LOGFILE=="
    "osReleaseId==$OS_RELEASE_ID=="
    "arch==$ARCH=="
    "platform==$PLATFORM=="
    "tmpDir==$TMP_DIR=="
    ${envVariables.map(envVar => `"${envVar}==$${envVar}=="`).join('\n')}
    "${id}: end"
}

# Check machine architecture
$ARCH=$env:PROCESSOR_ARCHITECTURE
# Use x64 version for ARM64, as it's not yet available.
if(($ARCH -eq "AMD64") -or ($ARCH -eq "IA64") -or ($ARCH -eq "ARM64")) {
    $SERVER_ARCH="x64"
}
else {
    "Error architecture not supported: $ARCH"
    printInstallResults 1
    exit 0
}

# Create installation folder
if(!(Test-Path $SERVER_DIR)) {
    try {
        ni -it d $SERVER_DIR -f -ea si
    } catch {
        "Error creating server install directory - $($_.ToString())"
        exit 1
    }

    if(!(Test-Path $SERVER_DIR)) {
        "Error creating server install directory"
        exit 1
    }
}

cd $SERVER_DIR

# Check if server script is already installed
if(!(Test-Path $SERVER_SCRIPT)) {
    del vscode-server.tar.gz

    $REQUEST_ARGUMENTS = @{
        Uri="${downloadUrl}"
        TimeoutSec=20
        OutFile="vscode-server.tar.gz"
        UseBasicParsing=$True
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    Invoke-RestMethod @REQUEST_ARGUMENTS

    if(Test-Path "vscode-server.tar.gz") {
        tar -xf vscode-server.tar.gz --strip-components 1

        del vscode-server.tar.gz
    }

    if(!(Test-Path $SERVER_SCRIPT)) {
        "Error while installing the server binary"
        exit 1
    }
}
else {
    "Server script already installed in $SERVER_SCRIPT"
}

# Try to find if server is already running
if(Get-Process node -ErrorAction SilentlyContinue | Where-Object Path -Like "$SERVER_DIR\\*") {
    echo "Server script is already running $SERVER_SCRIPT"
}
else {
    if(Test-Path $SERVER_LOGFILE) {
        del $SERVER_LOGFILE
    }
    if(Test-Path $SERVER_PIDFILE) {
        del $SERVER_PIDFILE
    }
    if(Test-Path $SERVER_TOKENFILE) {
        del $SERVER_TOKENFILE
    }

    $SERVER_CONNECTION_TOKEN="${crypto.randomUUID()}"
    [System.IO.File]::WriteAllLines($SERVER_TOKENFILE, $SERVER_CONNECTION_TOKEN)

    $SCRIPT_ARGUMENTS="--start-server --host=127.0.0.1 $SERVER_LISTEN_FLAG $SERVER_INITIAL_EXTENSIONS --connection-token-file $SERVER_TOKENFILE --telemetry-level off --enable-remote-auto-shutdown --accept-server-license-terms *> '$SERVER_LOGFILE'"

    $START_ARGUMENTS = @{
        FilePath = "powershell.exe"
        WindowStyle = "hidden"
        ArgumentList = @(
            "-ExecutionPolicy", "Unrestricted", "-NoLogo", "-NoProfile", "-NonInteractive", "-c", "$SERVER_SCRIPT $SCRIPT_ARGUMENTS"
        )
        PassThru = $True
    }

    $SERVER_ID = (start @START_ARGUMENTS).ID

    if($SERVER_ID) {
        [System.IO.File]::WriteAllLines($SERVER_PIDFILE, $SERVER_ID)
    }
}

if(Test-Path $SERVER_TOKENFILE) {
    $SERVER_CONNECTION_TOKEN="$(cat $SERVER_TOKENFILE)"
}
else {
    "Error server token file not found $SERVER_TOKENFILE"
    printInstallResults 1
    exit 0
}

sleep -Milliseconds 500

$SELECT_ARGUMENTS = @{
    Path = $SERVER_LOGFILE
    Pattern = "Extension host agent listening on (\\d+)"
}

for($I = 1; $I -le 5; $I++) {
    if(Test-Path $SERVER_LOGFILE) {
        $GROUPS = (Select-String @SELECT_ARGUMENTS).Matches.Groups

        if($GROUPS) {
            $LISTENING_ON = $GROUPS[1].Value
            break
        }
    }

    sleep -Milliseconds 500
}

if(!(Test-Path $SERVER_LOGFILE)) {
    "Error server log file not found $SERVER_LOGFILE"
    printInstallResults 1
    exit 0
}

# Finish server setup
printInstallResults 0

if($SERVER_ID) {
    while($True) {
        if(!(gps -Id $SERVER_ID)) {
            "server died, exit"
            exit 0
        }

        sleep 30
    }
}
`;
}

