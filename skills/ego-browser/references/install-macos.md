# Install ego lite on macOS

Read `install.md` first; it covers upgrading an older ego lite and the onboarding step shared by every platform. This file has the macOS install steps, the commands that confirm the installation, and macOS troubleshooting.

## Run the install script

The install script lives at `scripts/install.sh` in this skill and supports macOS only (`uname -s` is `Darwin`). It will:

- Download the ego lite installer (a DMG) for your CPU architecture (arm64 / x64), using HTTPS for the request and all redirects.
- Remove only `com.apple.FinderInfo` metadata from the temporary staged copy, without following symbolic links. This handles packaging metadata described in [Apple QA1940](https://developer.apple.com/library/archive/qa/qa1940/_index.html); quarantine attributes and original code signatures are preserved.
- Verify the app's complete code signature, the pinned Citro Labs Developer ID (`JGQLC6YQYJ`), bundle ID (`com.citrolabs.ego.lite`), and Gatekeeper acceptance before installing it to `/Applications`.
- Preserve quarantine attributes and verify the installed app again before launch. A failed check stops installation or launch.

The script accepts signed app bundles only; it does not execute PKG installers. It may request administrator privileges to place a verified app in `/Applications`. The pinned identity is also reported in [the upstream signing report](https://github.com/citrolabs/ego-lite/issues/292); identity changes require review rather than learning a new identity from the download.

Run the script (use the script's actual path under this skill's directory):

```bash
sh skills/ego-browser/scripts/install.sh
```

After installing, the script opens the verified ego lite app. If ego lite is already installed in `/Applications` or `~/Applications`, it skips the download and performs the same signature, identity, and Gatekeeper checks before opening it.

After the script opens the ego lite app, the user completes the first-run onboarding in the app (see `install.md`). Onboarding registers the `ego-browser` command on the PATH, usually under `~/.local/bin`.

## After installing: confirm `ego-browser` is available

Once the user has finished onboarding, confirm the command is ready:

```bash
command -v ego-browser
```

If it reports that the command isn't found, `~/.local/bin` is most likely not on the current PATH. Fix it temporarily and retry:

```bash
export PATH="$HOME/.local/bin:$PATH"
command -v ego-browser
```

Once the command exists, verify the runtime:

```bash
ego-browser nodejs <<'EOF'
console.log('ego-browser ready')
EOF
```

Printing `ego-browser ready` means the environment is ready. Finally confirm that the installed ego lite prints its usage guide:

```bash
ego-browser skill
```

Then return to the user's original task, as `install.md` describes.

## Troubleshooting

- **Download failed**: the script retries 3 times automatically; if it still fails, it's usually a network issue — have the user check their network and retry.
- **Signature, identity, or Gatekeeper check fails**: stop and obtain a corrected release from the official website or contact the publisher. Do not remove quarantine, disable Gatekeeper, or bypass the failed check.
- **`resource fork, Finder information, or similar detritus not allowed`**: the current script already normalizes Finder metadata on downloaded staging copies and then reruns full verification. Existing installed apps are verified without modification; if one fails, obtain a fresh verified release. Resource forks or any remaining signature errors still stop installation.
- **Command still unavailable after onboarding**: confirm `~/.local/bin` is on the PATH (see above). Otherwise have the user reopen ego lite, finish onboarding, and retry.
