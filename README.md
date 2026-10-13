# The Horny Builder (beta)

A room editor for 3DXChat worlds: a clearer 3D view with fewer bugs and a friendlier way to build than the game's own builder.

**This is a beta.** Please stress-test it: build, break things, and tell us what goes wrong.

## Start building

1. **Download the helper** from [Releases](../../releases/latest) and unzip it anywhere.
2. **Run `Setup.bat` once.** It:
   - gets the helper ready (you need [Python 3.10+](https://www.python.org/downloads/); tick "Add python.exe to PATH" when installing);
   - reads the 3DXChat models from **your own** game;
   - puts a **The Horny Builder** shortcut on your desktop.
3. **Start The Horny Builder** from that shortcut. The editor opens in your browser by itself. Keep the helper's window open while you build.
4. In the editor, pick your **Worlds folder** (usually `Documents\3DXChat\Worlds`) and open a room with **☰ → Load room**.

After a 3DXChat update, run `Setup.bat` again to refresh the models.

## Your files stay on your PC

- **Your rooms:** read and saved on your own disk, through the helper.
- **The game's models:** extracted from your own game, kept in `%LOCALAPPDATA%\3DX Editor`, and never uploaded.
- **The editor page:** lives here on GitHub. The helper fetches it each time you start, so you always get the latest fixes, but nothing you open in it is sent anywhere.

## Feedback

- **Bugs:** [report a bug](../../issues/new?template=bug.yml), or use **Settings → About & feedback** in the editor, which fills in your versions.
- **Ideas:** [suggest an idea](../../issues/new?template=idea.yml).

You need a free GitHub account to post.

## Coming later

**AI building:** describe a room and an AI assistant builds it with you. It arrives after the first round of bug fixes.

## Legal

- **Licence:** © 2026 ToxicLizard99. All rights reserved; see [LICENSE](LICENSE). You may use the editor through this page to build your own rooms. Copying, changing or redistributing its code is not allowed.
- **No affiliation:** this is a fan-made tool, not made by or affiliated with the makers of 3DXChat. No game files are included or hosted here; the models come from each user's own installed game.
