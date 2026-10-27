# Work-Relevant Filter

A Chrome extension that blocks Reddit pages that aren't relevant to your work. An LLM on Groq judges each page against a description of your work. If Groq is unreachable, a keyword check takes over.

## Install

1. Get a free API key at <https://console.groq.com/keys>.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick this folder.
3. Click the extension icon, paste the key, click **Test key**, then **Save**.

## Personas

The popup starts from a preset persona: Software engineer (the default), AI consultant, Corporate lawyer or Science teacher. Choosing one fills in the work description and the backup keywords. Edit either field and the selector switches to **Custom**. The extension stores the two fields, not the persona, so a field that matches a preset exactly shows that preset.

## Backup keywords

The keyword backup reads a list with one entry per line. An entry that starts with `r/` names a subreddit that counts as relevant. Any other entry is a keyword or phrase. Short all-caps entries such as `API` match case-sensitively, so ordinary words don't trigger them.

## How a page is judged

Every Reddit page is covered by a "checking…" screen until it gets a verdict. The checks run in this order:

1. **Unlocks**: a page you unlocked in the last 5 minutes is allowed.
2. **Rules**: the home feed, r/popular, r/all and multireddits are always blocked. Settings and messages are always allowed.
3. **Your lists**: subreddits on the popup's allow or block list are decided instantly.
4. **Cache**: Groq verdicts are reused for 7 days. Saving a new work description clears the cache.
5. **Groq** gets the subreddit plus the post's title and body, or up to 15 post titles for a listing page, and returns `{relevant, reason}`. Ads and comments are never sent.
6. **Keyword backup**: used when there's no key, Groq errors, or a request takes longer than 6 seconds. It checks your backup keywords and skips negated mentions such as "NOT AI". Its verdicts aren't cached.

A blocked page shows the reason. To get past it, type why you need the page (at least 10 characters). That unlocks it for 5 minutes, and the popup logs every unlock.

## Files

- `lib.js`: pure shared logic (URL routing, prompt, reply parsing, keyword backup, cache), used by every other script and by the tests.
- `background.js`: service worker that calls Groq and stores verdicts, unlocks and logs.
- `content.js`: overlay, page extraction, and detecting Reddit's in-app navigation.
- `popup.html`, `popup.js`: settings and logs.
- `tools/make-icons.mjs`: draws `icons/*.png`. Run `node tools/make-icons.mjs` to regenerate them.

## Tests

```sh
node --test tests/*.test.js
```

## Privacy

Groq receives these items, under your own API key:

- the subreddit, the page type and the search query
- the post title and up to 1500 characters of its body, or up to 15 post titles for a listing
- your work description

Nothing goes anywhere else. Groq's own data policy applies: <https://groq.com/privacy-policy/>.

The API key, the verdict log with page titles, and your unlock reasons are stored unencrypted in `chrome.storage.local` on your device.

## Known limitations

- Post text can try to talk the model into allowing it. A prompt injection in a post may get that page through.
- The keyword backup is crude. It counts word matches and knows nothing about context.

## License

MIT. See `LICENSE`.
