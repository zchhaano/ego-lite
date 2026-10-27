#!/bin/sh
#v1.6 2026.10.27

set -eu

# Default package URL and installation paths.
DMG_URL_ARM64="https://cdn.ego.app/setup/macos/arm64/egolite-fHoqgZ74bOEM.dmg"
DMG_URL_X64="https://cdn.ego.app/setup/macos/x64/egolite-fHoqgZ74bOEM.dmg"
APP_NAME="ego lite"
APP_BUNDLE_NAME="$APP_NAME.app"
APP_PATH="/Applications/$APP_BUNDLE_NAME"
USER_APP_PATH="$HOME/Applications/$APP_BUNDLE_NAME"
EGO_BROWSER_HELPER_NAME="ego-browser"
# Pin the vendor and application identity, not metadata supplied by a download.
# Developer ID reported for official builds: https://github.com/citrolabs/ego-lite/issues/292
APP_REQUIREMENT='=anchor apple generic and identifier "com.citrolabs.ego.lite" and certificate leaf[subject.OU] = "JGQLC6YQYJ" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'

# Temporary directories created when mounting the DMG; cleaned up on exit.
TEMP_DIR=""
MOUNT_DIR=""
DMG_ATTACHED=""

log() {
	printf '%s\n' "$*" >&2
}

die() {
	log "error: $*"
	exit 1
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

select_dmg_url() {
	if [ "$(uname -m)" = "arm64" ]; then
		printf '%s\n' "$DMG_URL_ARM64"
	else
		printf '%s\n' "$DMG_URL_X64"
	fi
}

run_with_sudo_if_needed() {
	# Try without elevated privileges first; fall back to sudo to avoid unnecessary prompts.
	if "$@"; then
		return 0
	fi

	if [ "$(id -u)" -eq 0 ]; then
		return 1
	fi

	require_command sudo
	sudo "$@"
}

cleanup() {
	# Detach the DMG and remove the temp directory on success, failure, or Ctrl+C.
	if [ "$DMG_ATTACHED" = "1" ]; then
		if ! hdiutil detach "$MOUNT_DIR" -quiet >/dev/null 2>&1; then
			log "warning: failed to detach $MOUNT_DIR"
		fi
		DMG_ATTACHED=""
	fi

	if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
		rm -rf "$TEMP_DIR" >/dev/null 2>&1 ||
			log "warning: failed to remove temporary directory: $TEMP_DIR"
	fi
}

verify_ego_lite_app() {
	app_path="$1"
	[ -d "$app_path" ] && [ ! -L "$app_path" ] ||
		die "expected a regular app bundle at $app_path"
	# Check all nested code and the pinned Apple Developer ID before any install or launch.
	codesign --verify --deep --strict --verbose=2 \
		--test-requirement="$APP_REQUIREMENT" "$app_path" ||
		die "$APP_NAME signature or developer identity verification failed; obtain a verified release from https://lite.ego.app/"
	spctl --assess --type execute --verbose=2 "$app_path" ||
		die "Gatekeeper rejected $APP_NAME; installation and launch stopped without bypassing macOS security"
}

trap cleanup EXIT HUP INT TERM

find_ego_browser_in_app() {
	app_path="$1"

	[ -d "$app_path/Contents" ] || return 1

	# A Chromium app bundle may contain multiple versions; prefer the one under Current.
	for candidate in "$app_path"/Contents/Frameworks/*.framework/Versions/Current/Helpers/"$EGO_BROWSER_HELPER_NAME"; do
		if [ -x "$candidate" ]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done

	# ego-browser may live in various locations inside the bundle; search under Contents.
	browser_path=$(
		find "$app_path/Contents" -type f -name "$EGO_BROWSER_HELPER_NAME" 2>/dev/null |
			while IFS= read -r candidate; do
				if [ -x "$candidate" ]; then
					printf '%s\n' "$candidate"
					break
				fi
			done
	)

	if [ -n "$browser_path" ]; then
		printf '%s\n' "$browser_path"
		return 0
	fi

	return 1
}

is_ego_lite_app() {
	app_path="$1"

	# Discover a candidate only. Its signature and Gatekeeper status are checked before use.
	[ -d "$app_path" ] || return 1
	find_ego_browser_in_app "$app_path" >/dev/null
}

find_ego_lite_app() {
	for app_path in "$APP_PATH" "$USER_APP_PATH"; do
		if is_ego_lite_app "$app_path"; then
			printf '%s\n' "$app_path"
			return 0
		fi
	done

	for apps_dir in "$(dirname "$APP_PATH")" "$(dirname "$USER_APP_PATH")"; do
		[ -d "$apps_dir" ] || continue

		app_path=$(
			find "$apps_dir" -maxdepth 1 -type d -iname "$APP_BUNDLE_NAME" 2>/dev/null |
				while IFS= read -r candidate; do
					if is_ego_lite_app "$candidate"; then
						printf '%s\n' "$candidate"
						break
					fi
				done
		)
		if [ -n "$app_path" ]; then
			printf '%s\n' "$app_path"
			return 0
		fi
	done

	return 1
}

install_ego_lite() {
	require_command curl
	require_command hdiutil

	# Download and mount the DMG in an isolated temp directory to avoid polluting the CWD.
	temp_base_dir=${TMPDIR:-/tmp}
	temp_base_dir=${temp_base_dir%/}
	TEMP_DIR=$(mktemp -d "$temp_base_dir/ego-lite-install.XXXXXX")
	MOUNT_DIR="$TEMP_DIR/mount"
	dmg_path="$TEMP_DIR/egolite.dmg"
	dmg_url=$(select_dmg_url)
	mkdir -p "$MOUNT_DIR"

	log "$APP_NAME is not installed. Downloading $dmg_url ..."
	curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
		-fL --retry 3 --output "$dmg_path" "$dmg_url" ||
		die "failed to download $APP_NAME from $dmg_url"

	log "Mounting installer ..."
	hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$MOUNT_DIR" \
		>/dev/null
	DMG_ATTACHED="1"

	# Handle DMGs that contain the app bundle directly.
	app_in_dmg=$(
		find "$MOUNT_DIR" -maxdepth 2 \
			-type d -iname "$APP_BUNDLE_NAME" |
			head -n 1
	)

	if [ -n "$app_in_dmg" ]; then
		staged_app="$TEMP_DIR/$APP_BUNDLE_NAME"

		log "Staging and verifying $APP_NAME ..."
		ditto "$app_in_dmg" "$staged_app" ||
			die "failed to stage $APP_NAME from installer"
		find_ego_browser_in_app "$staged_app" >/dev/null ||
			die "installed $APP_NAME does not contain $EGO_BROWSER_HELPER_NAME"
		verify_ego_lite_app "$staged_app"

		log "Installing verified $APP_NAME to $APP_PATH ..."
		if [ -d "$APP_PATH" ]; then
			run_with_sudo_if_needed rm -rf "$APP_PATH" ||
				die "failed to replace existing $APP_PATH"
		fi
		run_with_sudo_if_needed mv "$staged_app" "$APP_PATH" ||
			die "failed to move $APP_NAME to $APP_PATH"
		return 0
	fi

	# A PKG can execute privileged installation scripts. This installer accepts only
	# app bundles whose complete contents can be verified before installation.
	die "cannot find $APP_NAME app in mounted DMG; PKG installers are not supported"
}

main() {
	[ "$(uname -s)" = "Darwin" ] || die "this script only supports macOS; on Windows and other platforms install from https://lite.ego.app/"
	require_command codesign
	require_command spctl

	# Install first if not present; otherwise use the ego-browser bundled inside the app.
	installed_app_path=$(find_ego_lite_app || true)
	if [ -z "$installed_app_path" ]; then
		install_ego_lite
		installed_app_path=$(find_ego_lite_app || true)
		[ -n "$installed_app_path" ] ||
			die "$APP_NAME install completed, but app was not found"
	fi

	verify_ego_lite_app "$installed_app_path"
	cleanup

	log "Launching $APP_NAME ..."
	exec open "$installed_app_path"
}

main
