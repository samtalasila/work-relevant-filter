# Site Blocker

A Chrome extension that blocks x.com, twitter.com and linkedin.com, subdomains included. It is separate from the Reddit filter in the folder above and shares no code with it.

## Install

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick this `site-blocker` folder.

Blocking starts right away. A blocked page redirects to a short notice. Tabs that are already open on those sites are sent to the notice too, including single-page apps that never reload.

## Pause and off

Click the extension icon.

- **Blocking**: **Pause 5 min** lifts the block with a live countdown, or **Turn off** lifts it until you turn it back on.
- **Paused**: **Resume now** ends the pause early, or **Turn off** switches blocking off.
- **Off**: **Turn on** restores blocking.

When a pause runs out, blocking comes back on its own and open tabs on those sites are redirected again.

## How it works

The state is one value under the `blocking` key in `chrome.storage.local`: `{mode: 'on'}`, `{mode: 'off'}`, or `{mode: 'paused', until: <epoch ms>}`. A missing or unreadable value means on.

The service worker turns that state into one `declarativeNetRequest` dynamic rule that redirects main-frame requests for the three domains to `blocked.html`. It re-applies the state on install, on browser start, and whenever the value changes, and each run converges on the same result. A pause sets a `chrome.alarms` alarm for its deadline. The plain `declarativeNetRequest` permission is enough because the extension holds host access to the three domains. The `web_accessible_resources` entry lets pages on those domains be redirected to `blocked.html`.

## Files

- `lib.js`: pure shared logic (state parsing, `isBlocking`, the domain list, the pause length), used by the service worker, the popup and the tests.
- `background.js`: service worker that applies the rule, redirects open tabs and handles the resume alarm.
- `blocked.html`: the page a blocked request lands on.
- `popup.html`, `popup.js`: status and controls.
- `tools/make-icons.mjs`: draws `icons/*.png`. Run `node tools/make-icons.mjs` to regenerate them.
- `tools/verify.mjs`: loads the extension into Chromium and checks blocking, off, pause and the popup end to end.

## Tests

```sh
node --test tests/*.test.js
```

To check the real extension, point `CHROMIUM` at a Chromium build (Chrome stable ignores `--load-extension`; Playwright's build works) and run `node tools/verify.mjs`. It needs network access to load the sites while blocking is off.

## Known limitations

- Anyone with access to the popup can turn blocking off. It is a speed bump for you, not a lock.
- Other browsers and other profiles are not covered.

## License

MIT. See `LICENSE` in the folder above.
