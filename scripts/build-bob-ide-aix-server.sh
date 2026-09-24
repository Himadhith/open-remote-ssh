#!/bin/bash
# build-bob-ide-aix-server.sh
#
# Builds a Bob IDE Remote Extension Host tarball patched for AIX ppc64.
#
# Run this script ON the AIX machine (or any AIX build host) with:
#   bash build-bob-ide-aix-server.sh <bob-ide-linux-x64-reh.tar.gz> <commit-hash>
#
# It mirrors the approach used by tonykuttai/vscodium-aix-server:
#   1. Extract the Linux x64 REH tarball from Bob IDE
#   2. Build native modules (node-pty, @vscode/spdlog, native-watchdog) for AIX ppc64
#      using a patched node-pty fork and portlibforaix
#   3. Replace the Linux binaries with the AIX-compiled ones
#   4. Write an AIX Node.js wrapper script
#   5. Repackage as bob-ide-reh-aix-ppc64-<version>.tar.gz
#
# The resulting tarball can then be hosted (e.g. on GitHub releases or IBM COS)
# and downloaded by the extension's install script instead of re-compiling on
# every connect.
#
# Prerequisites on AIX:
#   - Node.js 22.x at /opt/nodejs/bin/node
#   - GCC/G++ 10.3+ at /opt/freeware/bin/g++
#   - GNU make
#   - git, curl/wget
#   - Python 3.x (for node-gyp)
#
# Usage:
#   bash build-bob-ide-aix-server.sh \
#       bob-ide-reh-linux-x64-1.126.0+bob2.1.0.tar.gz \
#       a8240f78e496c1c620ab7078856ee817ae182991

set -e

#=============================================================================
# Arguments
#=============================================================================

SOURCE_TARBALL="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
COMMIT_HASH="$2"

if [[ -z "$SOURCE_TARBALL" || -z "$COMMIT_HASH" ]]; then
    echo "Usage: $0 <source-linux-x64-reh.tar.gz> <commit-hash>"
    echo ""
    echo "  SOURCE_TARBALL : Path to the Bob IDE Linux x64 REH tarball"
    echo "  COMMIT_HASH    : The Bob IDE server commit hash (shown in ~/.bobide-server/bin/)"
    echo ""
    echo "Example:"
    echo "  $0 bob-ide-reh-linux-x64-1.126.0+bob2.1.0.tar.gz a8240f78e496c1c620ab7078856ee817ae182991"
    exit 1
fi

if [[ ! -f "$SOURCE_TARBALL" ]]; then
    echo "ERROR: Source tarball not found: $SOURCE_TARBALL"
    exit 1
fi

#=============================================================================
# Configuration
#=============================================================================

NODE_BIN="/opt/nodejs/bin/node"
NPM_BIN="/opt/nodejs/bin/npm"
GPP_BIN="/opt/freeware/bin/g++"

BUILD_TMP="/tmp/bob-ide-aix-build-$$"
SERVER_DIR="$BUILD_TMP/server"
MODULES_DIR="$BUILD_TMP/modules"
PORTLIB_INSTALL="$HOME/local/portlibforaix"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/../releases"

# Derive version string from tarball name
TARBALL_BASENAME=$(basename "$SOURCE_TARBALL")
# e.g. bob-ide-reh-linux-x64-1.126.0+bob2.1.0.tar.gz -> 1.126.0+bob2.1.0
VERSION=$(echo "$TARBALL_BASENAME" | sed 's/.*-linux-x64-//' | sed 's/\.tar\.gz//')
OUTPUT_TARBALL="bob-ide-reh-aix-ppc64-${VERSION}.tar.gz"

echo "=========================================="
echo "  Bob IDE AIX Server Build"
echo "=========================================="
echo "Source : $SOURCE_TARBALL"
echo "Version: $VERSION"
echo "Commit : $COMMIT_HASH"
echo "Output : $OUTPUT_DIR/$OUTPUT_TARBALL"
echo "=========================================="

#=============================================================================
# Prerequisite checks
#=============================================================================

for bin in "$NODE_BIN" "$NPM_BIN" "$GPP_BIN" git make python3; do
    cmd=$(basename "$bin")
    if ! command -v "$bin" >/dev/null 2>&1 && ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: Required tool not found: $bin"
        exit 1
    fi
done

NODE_VERSION=$("$NODE_BIN" -e "process.stdout.write(process.versions.node)")
echo "Node.js: $NODE_VERSION"
echo "G++: $($GPP_BIN --version | head -1)"

#=============================================================================
# Phase 1: Extract Linux x64 server
#=============================================================================

echo ""
echo "=== Phase 1: Extracting Linux x64 server ==="
mkdir -p "$SERVER_DIR"
cd "$SERVER_DIR"
/opt/freeware/bin/gtar -xzf "$SOURCE_TARBALL" --strip-components 1
echo "Extracted to: $SERVER_DIR"

#=============================================================================
# Phase 2: Build portlibforaix (provides libutil.so.2 required by node-pty)
#=============================================================================

echo ""
echo "=== Phase 2: Building portlibforaix ==="
if [[ -f "$PORTLIB_INSTALL/lib/libutil.so.2" ]]; then
    echo "portlibforaix already installed at $PORTLIB_INSTALL"
else
    mkdir -p "$MODULES_DIR"
    cd "$MODULES_DIR"
    git clone https://github.com/tonykuttai/portlibforaix.git portlibforaix
    cd portlibforaix
    mkdir -p "$PORTLIB_INSTALL/lib" "$PORTLIB_INSTALL/include"
    make
    make install
    echo "portlibforaix installed to $PORTLIB_INSTALL"
fi

#=============================================================================
# Phase 3: Build node-pty for AIX
# Uses the patched fork tonykuttai/node-pty which supports AIX/portlibforaix
#=============================================================================

echo ""
echo "=== Phase 3: Building node-pty for AIX ==="
PTY_DIR="$MODULES_DIR/node-pty"
if [[ ! -d "$PTY_DIR" ]]; then
    git clone https://github.com/tonykuttai/node-pty.git "$PTY_DIR"
fi
cd "$PTY_DIR"
mkdir -p build/Release lib/native-libs

# Copy libutil.so.2 from portlibforaix into node-pty's native-libs
cp "$PORTLIB_INSTALL/lib/libutil.so.2" lib/native-libs/

# Install JS dependencies (skip native build — we compile manually below)
"$NPM_BIN" install --ignore-scripts --no-audit --no-fund 2>/dev/null || true

# Compile pty.o
"$GPP_BIN" -o build/Release/pty.o -c src/unix/pty.cc \
    -I/opt/nodejs/include/node \
    -I"$HOME/.cache/node-gyp/${NODE_VERSION}/include/node" \
    -I./node_modules/node-addon-api \
    -I/opt/freeware/include \
    -std=gnu++17 -D_GLIBCXX_USE_CXX11_ABI=0 \
    -fPIC -pthread -Wall -Wextra -Wno-unused-parameter \
    -maix64 -O3 -fno-omit-frame-pointer

# Link pty.node
"$GPP_BIN" -shared -maix64 \
    -Wl,-bimport:/opt/nodejs/include/node/node.exp \
    -pthread \
    -o build/Release/pty.node \
    build/Release/pty.o \
    lib/native-libs/libutil.so.2 \
    -lpthread -lstdc++

# Verify
"$NODE_BIN" -e "require('./build/Release/pty.node'); process.stdout.write('node-pty OK\n')"
echo "node-pty built successfully"

#=============================================================================
# Phase 4: Build @vscode/spdlog for AIX
#=============================================================================

echo ""
echo "=== Phase 4: Building @vscode/spdlog for AIX ==="
SPDLOG_DIR="$SERVER_DIR/node_modules/@vscode/spdlog"
if [[ -d "$SPDLOG_DIR" ]]; then
    cd "$SPDLOG_DIR"
    # Patch out -fstack-protector from node-gyp's addon.gypi (AIX g++ rejects it)
    GYPI="/opt/nodejs/lib/node_modules/npm/node_modules/node-gyp/addon.gypi"
    if [[ -f "$GYPI" ]]; then
        sed -i s/-fstack-protector[^\ ]*// "$GYPI" 2>/dev/null || true
    fi
    CXXFLAGS="-ftls-model=global-dynamic -fPIC -pthread -fno-stack-protector" \
    CFLAGS="-ftls-model=global-dynamic -fPIC -pthread -fno-stack-protector" \
    "$NPM_BIN" rebuild --build-from-source 2>&1 || echo "[WARN] spdlog rebuild failed, continuing"
    cd "$SERVER_DIR"
fi

#=============================================================================
# Phase 5: Build native-watchdog for AIX
#=============================================================================

echo ""
echo "=== Phase 5: Building native-watchdog for AIX ==="
for WD_DIR in "$SERVER_DIR/node_modules/native-watchdog" "$SERVER_DIR/node_modules/@vscode/native-watchdog"; do
    if [[ -d "$WD_DIR" ]]; then
        cd "$WD_DIR"
        CXXFLAGS="-ftls-model=global-dynamic -fPIC -pthread -fno-stack-protector" \
        CFLAGS="-ftls-model=global-dynamic -fPIC -pthread -fno-stack-protector" \
        "$NPM_BIN" rebuild --build-from-source 2>&1 || echo "[WARN] native-watchdog rebuild failed, continuing"
        cd "$SERVER_DIR"
    fi
done

#=============================================================================
# Phase 6: Install AIX-compiled node-pty into server
#=============================================================================

echo ""
echo "=== Phase 6: Installing AIX node-pty into server ==="
PTY_TARGET="$SERVER_DIR/node_modules/node-pty"
rm -rf "$PTY_TARGET"
cp -r "$PTY_DIR" "$PTY_TARGET"
echo "Installed node-pty to $PTY_TARGET"

#=============================================================================
# Phase 7: Write AIX Node.js wrapper
#=============================================================================

echo ""
echo "=== Phase 7: Writing AIX Node.js wrapper ==="
SERVER_APP_NAME=$(grep -o '"serverApplicationName"[^"]*"[^"]*"' "$SERVER_DIR/product.json" 2>/dev/null | cut -d'"' -f4 || echo "bobide-server")
WRAPPER="$SERVER_DIR/bin/$SERVER_APP_NAME"
mkdir -p "$SERVER_DIR/bin"
cat > "$WRAPPER" << 'WRAPEOF'
#!/bin/bash
# AIX Node.js wrapper for Bob IDE remote server
NODE_BIN="/opt/nodejs/bin/node"
if [[ ! -x "$NODE_BIN" ]]; then
    echo "ERROR: Node.js not found at $NODE_BIN" >&2
    exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
for candidate in \
    "$SCRIPT_DIR/../out/server-main.js" \
    "$SCRIPT_DIR/../out/vs/server/main.js"; do
    if [[ -f "$candidate" ]]; then
        exec "$NODE_BIN" "$candidate" "$@"
    fi
done
echo "ERROR: Bob IDE server entry point not found" >&2
exit 1
WRAPEOF
chmod +x "$WRAPPER"
echo "Wrapper written to $WRAPPER"

#=============================================================================
# Phase 8: Package
#=============================================================================

echo ""
echo "=== Phase 8: Packaging ==="
mkdir -p "$OUTPUT_DIR"
cd "$BUILD_TMP"
# Package with commit hash as top-level directory name (matches how the
# extension's install script expects to extract it with --strip-components 1)
mv server "$COMMIT_HASH"
/opt/freeware/bin/gtar -czf "$OUTPUT_DIR/$OUTPUT_TARBALL" "$COMMIT_HASH/"
echo "Package: $OUTPUT_DIR/$OUTPUT_TARBALL"
echo "Size: $(du -h "$OUTPUT_DIR/$OUTPUT_TARBALL" | cut -f1)"

# SHA256
CHECKSUM=$(csum -h SHA256 "$OUTPUT_DIR/$OUTPUT_TARBALL" | awk '{print $1}')
echo "$CHECKSUM" > "$OUTPUT_DIR/${OUTPUT_TARBALL}.sha256"
echo "SHA256: $CHECKSUM"

#=============================================================================
# Cleanup
#=============================================================================

rm -rf "$BUILD_TMP"
echo ""
echo "=========================================="
echo "  Build complete!"
echo "  $OUTPUT_DIR/$OUTPUT_TARBALL"
echo "=========================================="
