# Steam button: notes for building the Millennium plugin

The button opens a popup **inside Steam** listing your Moonshine friends. You tick who to invite and
click **Start streaming**. Moonshine, started hidden in the tray if it isn't running, makes sure this PC
is hosting and sends each friend the normal "join my game" invite. No Moonshine window opens.

Moonshine (0.5.0 and later) provides two ways in:

| | Local API (use this for the button) | `moonshine://stream?friend=` link |
|---|---|---|
| Friends list for a picker | yes | no |
| Result back to the caller | yes (JSON) | no |
| Moonshine asks again in its own popup | no | yes, always |
| Good for | the Steam popup | desktop shortcuts, Stream Deck keys |

## Local API

Moonshine listens on `127.0.0.1` on a random port while it runs, and writes the port and a secret token to:

```
%APPDATA%\Moonshine\local-api.json      {"port":53122,"token":"...","pid":1234}
```

A new token is made every time Moonshine starts, and the file is deleted when it quits. Calls need the
header `Authorization: Bearer <token>`. Requests with an `Origin` header (from browsers) or a Host other
than `127.0.0.1`/`localhost` are refused.

`GET /friends`
```json
{"signedIn":true,"hosting":true,"friends":[{"username":"Bob","nickname":"Bobby","name":"Bobby","online":true}]}
```
- `name` is what to show (the nickname if set, else the username). `username` is what to send back.
- `hosting: false` means this PC's host service is stopped. Inviting starts it by itself, so this is only for
  a hint such as "Hosting will start when you click Start streaming".
- `signedIn: false` means Moonshine isn't signed in to an account; `friends` is empty.

`POST /invite` with body `{"friends":["Bob","Carol"],"game":"Hades II"}` (usernames, at most 4; `game` is optional)
```json
{"ok":true,"invited":["Bobby","Carol"],"error":""}
```
- `game` is the title the friend's invite popup shows ("Hades II on BOB-PC wants you to join"), so send the name of
  the Steam game the button was clicked on. Without it the popup shows the app name ("Desktop"). Spaces are tidied
  and it is cut to 80 characters. It is only a label; what the friend streams is still this PC's desktop. A friend on
  an older Moonshine just sees "Desktop".
- `ok` is true if at least one friend was invited. `error` holds the reason for any that failed, for
  example "Hosting didn't start..." (the Windows prompt was declined) or "dave isn't in your friends list."
- **Inviting turns hosting on if it's off:** it ends a pause and starts the host service. Starting a service
  needs administrator rights, so **Windows shows its permission (UAC) prompt**. That's expected, and the
  user must click Yes. Declining gives "Hosting didn't start...".
- It can take up to about 15 seconds right after Moonshine starts (it connects to the friends service),
  and up to about 45 more seconds if hosting has to start, plus however long the user takes to answer the
  Windows prompt. Show "Inviting..." and don't time out early (the script allows 150 seconds).
- Moonshine also shows the result as a tray notification.

Usernames are always 3 to 20 letters, numbers, dots, dashes or underscores.

## The ready-made script: `moonshine-api.ps1`

Sent alongside these notes, and tested against Moonshine with Windows PowerShell. It reads the file, makes
the call, starts Moonshine hidden if it isn't running, and prints one line of JSON:

```
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File moonshine-api.ps1 -Action friends
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File moonshine-api.ps1 -Action invite -Friends "Bob,Carol" -GameB64 "SGFkZXMgSUk="
```
`-GameB64` is the game title as UTF-8 **base64**, which is the safe way to pass any title (quotes, `&`, accents, ™) on a
command line; encode it in Lua or in the front end before building the command. `-Game "Hades II"` also works for
titles made only of letters, digits and spaces.
Failures print `{"ok":false,"error":"..."}` and exit with 1. The first call after Moonshine was closed
can take a while (it waits up to 30 seconds for Moonshine to start).

## Notes for the AI writing the plugin

Millennium is a third-party Steam client modding framework. These notes were written without its current
documentation; check it for the popup/modal components, how to add the button, and the back-end API.
The plugin already has a working button, a Lua back end and a friends setting; this replaces the setting
with a live picker.

1. **Copy `moonshine-api.ps1` into the plugin's back-end folder** and run it from Lua the way the plugin
   already runs PowerShell (`utils.exec`), with the full path to the script. Return the JSON line to the
   front end and parse it there. Don't reimplement the HTTP calls or token handling unless the script
   can't be used.
2. **Only pass usernames that came from `-Action friends`.** They are restricted to `A-Z a-z 0-9 _ . -`,
   so they're safe on the command line. Still check each against `^[A-Za-z0-9_.-]{3,20}$` before building
   the command, and quote the `-Friends` value.
3. **Button click:** open the popup straight away with a "Loading friends..." state, then call
   `friends` in the background. Don't block Steam's UI while PowerShell runs.
4. **The popup:**
   - one tick-box per friend showing `name`, with an online dot from `online`; online friends first;
   - at most 4 can be ticked;
   - a **Start streaming** button, enabled once at least one friend is ticked, and a Cancel button;
   - if `hosting` is false, a small note above the button: "Hosting will start when you click Start streaming
     (Windows may ask for permission)." Don't block the button;
   - if `signedIn` is false or the call failed, show the message instead of the list, with a Retry button;
   - if the list is empty: "No friends yet. Add friends in Moonshine's Connect tab."
5. **Start streaming:** disable the button, show "Inviting...", run `-Action invite -Friends "user1,user2" -GameB64 <base64 of the game name>`,
   then show the result: "Invited Bobby, Carol." on success, otherwise `error`. Close the popup a couple of
   seconds after success; keep it open on failure.
6. **Remember the last ticked friends** (in the plugin's storage) and pre-tick them next time, if they're
   still in the list.
7. **Keep the old settings field only as a fallback**, or remove it. The picker replaces it.
8. **Don't** read or store the token anywhere else, call the API from the front end (the browser side), or
   send anything to other hosts.
9. **Non-Steam shortcuts need nothing special.** The button streams the whole PC, whichever game is open.
10. **Keep it small.** Steam updates can break Millennium plugins.

## What the friend's side does

- The friend gets the normal "invites you to play" popup showing the game title you sent, and joins by clicking Join.
- The host lets them connect without asking for **2 minutes** after they click Join, even if that device is set to
  "ask before streaming". The setting itself isn't changed, so the next time they connect without an invite, it asks again.

## Troubleshooting

- **Nothing happens / "Moonshine didn't answer":** Moonshine isn't running, or is running **as
  administrator** (for example, started from the installer's last page before 0.5.0). Quit it from the tray
  and open it from the Start menu. Windows blocks normal programs from reaching an admin program.
- **"Sign in to Moonshine first":** sign in from Moonshine's Connect tab.
- **"Hosting didn't start. Windows asks for permission...":** the Windows prompt was declined or missed. Click
  Start streaming again and choose Yes.

## The link, for shortcuts

```
moonshine://stream?friend=Bob,Carol     Moonshine asks "Start streaming?", then invites them
moonshine://stream                       opens Moonshine's Connect tab to pick a friend
moonshine://background                   only starts Moonshine hidden in the tray, if it isn't running
```
Usernames or nicknames work, in any letter case. The link always asks first, because any web page can open it.
