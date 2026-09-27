# ProPresenter Receiver

A browser-based graphics output that follows a live ProPresenter instance and renders
clean, modern overlays: lyric lower-thirds, scripture, announcements, sermon points,
animated speaker titles, messages, and the presentation's video/images, all laid out
according to ProPresenter's current **Look**.

It's a small Node.js server with no dependencies. Run it on a Linux or Windows machine (or
anywhere else), then open the display output full screen, or add it as a browser source in
OBS/vMix/Wirecast.

```
ProPresenter ──(network API: /v1/status/updates stream)──► Receiver server ──(SSE)──► /display  (output)
                                                                        └──────────► /          (control panel)
```

## Quick start

```bash
# Node 18 or newer. No npm install is needed for the app itself.
npm start            # or: node server/index.js
```

- Control panel: `http://<machine>:8080/`
- Output: `http://<machine>:8080/display`

In ProPresenter, open **Settings → Network** and enable **Network**. The Receiver scans the
local network and connects on its own when it finds exactly one instance, or the instance
you used last. You can also enter a host and port in the control panel. If you don't know
the port, leave it empty and click **Deep scan** to try every port on that host.

## What it does

| Feature | How |
|---|---|
| **Follows the active playlist** | Streams `playlist/active`. When the playlist changes, every presentation in it is pre-loaded, so slides are ready before they go live. It also re-reads the playlist every 30 s. |
| **Slide content** | Streams `status/slide` and `presentation/slide_index`, and uses the group names, labels and notes to classify each slide. |
| **Looks → layouts** | Streams `look/current`. The Look's name picks the layout (editable in the control panel), and its layers switch text, media and messages on or off. |
| **Speaker titles** | Animate in, hold for *N* seconds, then animate out. Three triggers: a slide in a **Speaker** group, the **Speaker Name** message, or the control panel. |
| **Media** | Reads the file path from the presentation's `.pro` file, streams the video to the browser, and keeps it synced to ProPresenter's transport clock (within about 50 ms in testing). |
| **Discovery** | Uses Bonjour/mDNS when available, a subnet sweep of likely ports, and a full port scan on request. Each hit is confirmed with `GET /version`. |

### Content types

Each slide gets a type, chosen by these rules in order (see `server/classify.js`):

1. A `#tag` in the slide notes: `#lyrics` `#scripture` `#speaker` `#announcement` `#point` `#text` `#hide`
2. The group name or slide label:
   - `Verse`, `Chorus`, `Bridge`, `Tag`… → lyrics
   - `Scripture` or `Reading` → scripture
   - `Speaker` → speaker
   - `Announcement` or `Welcome` → announcement
   - `Sermon`, `Point` or `Title` → point
3. Presentation metadata: CCLI info → song; a Bible reference → scripture
4. The text itself: a trailing `John 3:16 KJV`-style line → scripture

Multi-box slides keep their structure. The reference box becomes the scripture citation,
and the first box becomes the title (announcement/point) or the name (speaker).

### Layouts

| Layout | Used for |
|---|---|
| `lower-third` | Broadcast/stream graphics. Lyrics sit on a soft scrim (or a glass panel); scripture, announcements and points use an accent-striped panel. |
| `fullscreen` | Room screens. Large centred text, with media dimmed behind it. |
| `scripture-focus` | A larger reading panel for scripture; other types look the same as in lower-third. |
| `clean` | Media only; no text or messages. |

Default Look → layout rules (first match wins; change them in the control panel):
`Clean*` → clean, `*Full*` → fullscreen, `*Scripture*`/`*Focus*` → scripture-focus,
`*Lower*` → lower-third, anything else → the default layout.

### Output URL options

| URL | Use |
|---|---|
| `/display` | Uses the background from Settings (transparent by default) |
| `/display?bg=transparent` | OBS/vMix browser source, or an alpha key |
| `/display?bg=chroma` | Chroma key into a hardware switcher, using the colour set in Appearance (`&chroma=ff00ff` overrides it; `?bg=green` / `?bg=blue` still work) |
| `/display?layout=fullscreen&bg=black` | Always full screen, whatever the Look |
| `/display?layout=lower-third&media=0` | Stream graphics without media |
| `?speaker=0`, `?messages=0`, `?debug=1`, `?hint=0` | Turn off speaker titles, messages or the full-screen hint, or show a status badge |

You can run several outputs from one server at the same time.

The output page hides the mouse cursor. To go full screen, **double-click anywhere** or press
**F** (F or Esc to leave). Moving the mouse shows a short reminder at the top of the screen.
The reminder never appears in the control-panel preview or in OBS, and `?hint=0` turns it off
completely. The kiosk launcher (`deploy/kiosk.sh`) already opens full screen.

## Media (video and images)

ProPresenter's API doesn't serve media files. The Receiver finds them itself:

1. **Cue media**: the file path saved in the presentation's `.pro` document. The API gives
   the document's path, and the Receiver reads it.
2. **Media-bin items**: the playing file's name, looked up in the **Media folders**.
3. **Fallback**: ProPresenter's slide thumbnail, a still image (can be turned off).

When the Receiver runs on the same Mac as ProPresenter, this works without setup. On a
separate Linux box, mount ProPresenter's library and media folders read-only and add
**Path map** entries in the control panel:

```bash
sudo mount -t cifs //propresenter-mac/Media /mnt/pp/Media -o ro,guest
sudo mount -t cifs //propresenter-mac/ProPresenter /mnt/pp/ProPresenter -o ro,guest
```
```
/Users/av/Library/Application Support/RenewedVision/ProPresenter => /mnt/pp/ProPresenter
/Users/av/Movies => /mnt/pp/Media
```

The Receiver has to read the `.pro` files to know each cue's media and whether a
presentation is a song or a Bible passage. Without that access it still works, using the
group names, text and thumbnails instead.

Video plays muted by default (ProPresenter usually owns the audio). The browser must be
able to decode the file: H.264/HEVC `.mp4`/`.mov` and WebM work in Chrome, but ProRes and
some other pro codecs don't. For those, the thumbnail fallback is shown instead.

## Speaker titles

- **From a slide:** put name and title slides in a group named **Speaker**. Separate text
  boxes work best (name box, title box). You can also tag any slide with `#speaker` in its
  notes.
- **From a message:** trigger the ProPresenter message **Speaker Name**, whose tokens are
  `{Name}` and `{Title}`. Any message whose name matches the "Speaker message names" regex
  in Settings works.
- **Manually:** use the control panel. Speaker slides found in the playlist appear as
  one-click buttons.

The title moves up automatically so it never overlaps the lyrics or scripture on screen.
Hold time and style (accent panel or minimal) are in Appearance.

## Linux deployment

```bash
sudo useradd -r -m receiver
sudo cp -r . /opt/propresenter-receiver && sudo chown -R receiver /opt/propresenter-receiver
sudo cp deploy/propresenter-receiver.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now propresenter-receiver
```

For the on-screen output (HDMI/SDI out of the Linux box), start the kiosk browser, or copy
`deploy/propresenter-receiver-kiosk.desktop` into `~/.config/autostart/`:

```bash
./deploy/kiosk.sh                          # /display?bg=black, full screen
./deploy/kiosk.sh "/display?bg=green"      # any output URL
```

Settings are stored in `data/config.json`, or in `$RECEIVER_DATA` when set.

To keep the Receiver watch-only, turn off **Allow control of ProPresenter** (Discovery card,
or `"controlProPresenter": false` in the config). Prev/Next, Clear, Look and slide-cue
buttons are disabled, and the server refuses `/api/pp/*` with 403, so nothing is ever
triggered on the ProPresenter machine.

The Receiver needs to reach ProPresenter's network port (TCP). The control panel and output
are served on port 8080 (`PORT=…` to change it).

## Windows 11 deployment

### 1. Install Node.js

Open **PowerShell** (Start → type *PowerShell*) and run:

```powershell
winget install OpenJS.NodeJS.LTS
```

Close PowerShell and open a new window, then check that `node -v` prints `v18` or newer.
Or download the LTS installer from [nodejs.org](https://nodejs.org) and run it with the
default options.

### 2. Copy the app to the PC

Copy the whole app folder (USB stick, network share, OneDrive or a zip) to a folder you can
write to. `C:\ProPresenterReceiver` works well. The folder must contain `server`,
`public`, `deploy` and `package.json`. The `.git` folder and any `data` folder can be left
out.

Don't put it under `C:\Program Files`; settings can't be saved there (unless you use
`-DataDir`, below). You don't need to run `npm install`.

If you copied a zip, right-click it → **Properties** → tick **Unblock** before extracting,
or Windows may refuse to run the scripts.

### 3. Run the installer

Open `C:\ProPresenterReceiver\deploy\windows` and double-click **`install.cmd`**. Click
**Yes** at the admin prompt. The installer:

- adds a firewall rule allowing Node on Private and Domain networks, so other machines can
  open port 8080 and ProPresenter discovery replies get through;
- registers a scheduled task, **ProPresenter Receiver**, that starts the server hidden
  whenever you log on and restarts it if it stops;
- starts the server now and prints the control-panel address.

To also open the output full screen at logon, run the installer from a command prompt with
options instead:

```bat
cd C:\ProPresenterReceiver
deploy\windows\install.cmd -Kiosk                         :: open /display?bg=black full screen at logon
deploy\windows\install.cmd -Kiosk -Monitor 2              :: ...on the second display
deploy\windows\install.cmd -Kiosk -KioskPath "/display?bg=chroma" -Port 9090
deploy\windows\install.cmd -DataDir C:\ProgramData\ProPresenterReceiver
```

`-Monitor` counts from 1 (the primary display), then left to right. Run the installer again
at any time to change options.

### 4. Connect to ProPresenter

1. On the ProPresenter computer, open **Settings → Network** and turn on **Network**.
2. Open the control panel at `http://localhost:8080/`. The Receiver finds ProPresenter on
   its own. If it doesn't, type ProPresenter's IP address and port on the Discovery card,
   or enter just the IP and click **Deep scan**.
3. Make sure Windows treats the network as **Private** (Settings → Network & internet →
   your connection → *Private network*). On a *Public* network the firewall rule doesn't
   apply.

### 5. Show the output

- **On this PC's screen or projector:** use the `-Kiosk` option above, or double-click
  `deploy\windows\kiosk.cmd` to open it once. It uses Chrome if it's installed, otherwise
  Edge. Press **Alt+F4** to close it.
- **In OBS, vMix or Wirecast:** add a browser source with
  `http://<this-pc>:8080/display?bg=transparent`, at 1920×1080.
- **From another computer:** open `http://<this-pc>:8080/` (control panel) or `/display`.
  The installer prints this PC's address.

### Dedicated output PCs

The server runs as the logged-in user, so it only starts once someone signs in. On a PC
that should come up on its own after a power cut, set Windows to sign in automatically,
and turn off sleep (Settings → System → Power).

### Media

- **ProPresenter on the same PC:** `Documents\ProPresenter` is searched automatically. Add
  any other folders with your videos and images under **Media folders** in the control
  panel. If OneDrive backs up your Documents folder, add ProPresenter's folder inside
  OneDrive there too.
- **ProPresenter on a Mac:** share the Mac's ProPresenter library and media folders over
  SMB, map them as drives in File Explorer (This PC → **Map network drive**, e.g. `P:` and
  `M:`), and add **Path map** entries such as `/Users/av/Movies => M:\`.
- **ProPresenter on another Windows PC:** share its folders the same way and add entries
  such as `C:\Users\av\Videos => M:\`. Windows path-map entries ignore case and accept
  either slash.

### Updating, stopping and removing

- **Update:** copy the new files over the old folder (keep `data\`, which holds your
  settings), then run `install.cmd` again, or sign out and back in.
- **Stop or start:** open **Task Scheduler**, find **ProPresenter Receiver**, and choose
  **End** or **Run**.
- **Run by hand:** `deploy\windows\start.cmd` runs the server in a window, showing its
  output. Stop the scheduled task first so the port is free.
- **Remove:** double-click `deploy\windows\uninstall.cmd`. It removes the tasks and the
  firewall rule and stops the server. The app folder and settings stay until you delete
  them.

### Troubleshooting

| Problem | Fix |
|---|---|
| `node` is not recognized | Open a new window after installing Node.js, or reinstall it with the default options. |
| The installer window flashes and closes | Run `install.cmd` from a command prompt to see the error. |
| "running scripts is disabled" | Use the `.cmd` files rather than the `.ps1` files, and unblock the zip (step 2). |
| Control panel won't open from another computer | Set the network to Private, and check that the firewall rule **ProPresenter Receiver** exists. |
| ProPresenter isn't found | Check that Network is on in ProPresenter, then enter its IP and port by hand. |
| Something else | Check the log at `data\receiver.log` in the app folder. |

## Test content (`tools/seed`)

`npm run seed` writes a test library into ProPresenter (macOS paths by default). The
lyrics and scripture are public domain.

- **Songs:** Amazing Grace (with a motion loop), It Is Well With My Soul, Holy, Holy, Holy
- **Scripture:** John 3:16-17 and Psalm 23:1-4, KJV, with separate reference boxes
- **Speaker Intros:** three names and titles
- **Other:** Announcements, *Sermon – Rooted* (points and a background image), and a Welcome Bumper video
- **Messages:** **Speaker Name** (`{Name}`/`{Title}`) and **Parent Notice**
- **Playlist:** *Sunday Service (Receiver Test)*, in sections (Pre-Service, Worship, The Word)

Looks: on ProPresenter 21.4, looks created through the API don't appear until ProPresenter
restarts. Quit ProPresenter, then run `node tools/seed/looks.js` to add **Lower Thirds**,
**Full Screen Lyrics**, **Scripture Focus**, **Media + Lower Thirds** and **Clean Feed**.
It backs up the Workspace config first and removes duplicate looks.

`tools/seed/pro.js` is a small `.pro` writer built on the community
[ProPresenter7-Proto](https://github.com/greyshirtguy/ProPresenter7-Proto) schema (MIT).

## Project layout

```
server/
  index.js         HTTP server, SSE, control API, auto-connect
  propresenter.js  live connection: update stream, playlist pre-load, state builder
  discovery.js     mDNS + subnet sweep + deep port scan
  classify.js      slide → lyrics / scripture / speaker / announcement / point
  pro-file.js      reads cue media + song/Bible flags from .pro files (no deps)
  media.js         path mapping, media lookup, range-request streaming
  config.js        settings (data/config.json)
public/
  display.*        the output (1920×1080 stage scaled to the window)
  control.*        the control panel
deploy/            systemd unit, kiosk launcher, autostart entry
  windows/         Windows installer (scheduled tasks + firewall), kiosk and start scripts
tools/seed/        test-content generator for ProPresenter
test/              node --test unit tests (npm test)
```

Tested against ProPresenter 21.4 (API v1) on macOS 26.6.
