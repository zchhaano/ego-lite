# Install or upgrade ego lite

Read this file only when `ego-browser` is not found, when `ego-browser skill` reports an unknown command, or when the user asks to install ego lite. For day-to-day browser work, run `ego-browser skill` and follow its output.

The ego-browser skill depends on the ego lite browser: the `ego-browser` command is provided by the ego lite app. Once ego lite is installed and you've completed onboarding, no additional setup is normally needed.

ego lite website: https://lite.ego.app/

## Upgrade an older ego lite

If `ego-browser` exists but `ego-browser skill` reports `Unknown command: skill`, the installed ego lite is older than this skill. Ask the user for approval, then run:

```bash
ego-browser upgrade
```

If `upgrade` is also an unknown command, reinstall with the steps below. Then continue with "After installing: confirm `ego-browser` is available".

## Install on macOS

The install script lives at `scripts/install.sh` in this skill and supports macOS only. It will:

- Download the ego lite installer (a DMG) for your CPU architecture (arm64 / x64), using HTTPS for the request and all redirects.
- Verify the app's complete code signature, the pinned Citro Labs Developer ID (`JGQLC6YQYJ`), bundle ID (`com.citrolabs.ego.lite`), and Gatekeeper acceptance before installing it to `/Applications`.
- Preserve quarantine attributes and verify the installed app again before launch. A failed check stops installation or launch.

The script accepts signed app bundles only; it does not execute PKG installers. It may request administrator privileges to place a verified app in `/Applications`. The pinned identity is also reported in [the upstream signing report](https://github.com/citrolabs/ego-lite/issues/292); identity changes require review rather than learning a new identity from the download.

Run the script (use the script's actual path under this skill's directory):

```bash
sh skills/ego-browser/scripts/install.sh
```

After installing, the script opens the verified ego lite app. If ego lite is already installed in `/Applications` or `~/Applications`, it skips the download and performs the same signature, identity, and Gatekeeper checks before opening it.

After the script opens the ego lite app, the user completes the first-run onboarding in the app. Onboarding registers the `ego-browser` command on the PATH, usually under `~/.local/bin`.

## Install on Windows

There is no install script for Windows. Have the user download the installer from https://lite.ego.app/ and run it, then open ego lite.

## Onboarding

Onboarding is a step the user completes in the GUI, on either platform:

- Choose to import data from Chrome or another browser as needed.
- Onboarding registers the `ego-browser` command on the PATH.

After the app opens, wait for the user to confirm they've finished onboarding before continuing. On Windows the PATH entry only reaches processes started afterwards, so open a new terminal before checking for the command.

## After installing: confirm `ego-browser` is available

Once the user has finished onboarding, confirm the command is ready.

macOS and Linux shells:

```bash
command -v ego-browser
```

If it reports that the command isn't found, `~/.local/bin` is most likely not on the current PATH. Fix it temporarily and retry:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

PowerShell:

```powershell
Get-Command ego-browser
```

cmd:

```bat
where ego-browser
```

Once the command exists, verify the runtime. In Bash or Zsh:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

In PowerShell or cmd, where heredoc does not exist:

```powershell
ego-browser nodejs -e "console.log('ego-browser ready')"
```

Printing `ego-browser ready` means the environment is ready. Finally confirm that the installed ego lite prints its usage guide:

```bash
ego-browser skill
```

## After that, return to the original task

Once the environment is ready, return to the user's original task: run `ego-browser skill` and follow its output.

## Troubleshooting

- **Not macOS**: `scripts/install.sh` supports macOS only (`uname -s` is `Darwin`). On Windows and other platforms, have the user download and install from the ego lite website at https://lite.ego.app/.
- **Download failed**: the script retries 3 times automatically; if it still fails, it's usually a network issue — have the user check their network and retry.
- **Signature, identity, or Gatekeeper check fails (macOS)**: stop and obtain a corrected release from the official website or contact the publisher. Do not remove quarantine, disable Gatekeeper, or bypass the failed check.
- **SmartScreen blocks the installer (Windows)**: stop and verify the download and publisher with the official website; obtain a corrected release if its signature or reputation cannot be confirmed.
- **Command still unavailable after onboarding**: on macOS and Linux, confirm `~/.local/bin` is on the PATH (see above). On Windows, open a new terminal first, because an existing one keeps the PATH it started with. Otherwise have the user reopen ego lite, finish onboarding, and retry.
