# Work-Relevant Filter

A Chrome extension that blocks Reddit pages that aren't relevant to your work. An LLM on Groq judges each page against a description of your work. If Groq is unreachable, a keyword check takes over.

## Install

1. Get a free API key at <https://console.groq.com/keys>.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick this folder.
3. Click the extension icon, paste the key, click **Test key**, then **Save**.

## How a page is judged

Every Reddit page is covered by a "checking…" screen until it gets a verdict. The checks run in this order:

1. **Unlocks**: a page you unlocked in the last 5 minutes is allowed.
2. **Rules**: the home feed, r/popular, r/all and multireddits are always blocked. Settings and messages are always allowed.
3. **Your lists**: subreddits on the popup's allow or block list are decided instantly.
4. **Cache**: Groq verdicts are reused for 7 days. Saving a new work description clears the cache.
5. **Groq** gets the subreddit plus the post's title and body, or up to 15 post titles for a listing page, and returns `{relevant, reason}`. Ads and comments are never sent.
6. **Keyword backup**: used when there's no key, Groq errors, or a request takes longer than 6 seconds. It skips negated mentions such as "NOT AI". Its verdicts aren't cached.

A blocked page shows the reason. To get past it, type why you need the page (at least 10 characters). That unlocks it for 5 minutes, and the popup logs every unlock.

## Files

- `lib.js`: pure shared logic (URL routing, prompt, reply parsing, keyword backup, cache), used by every other script and by the tests.
- `background.js`: service worker that calls Groq and stores verdicts, unlocks and logs.
- `content.js`: overlay, page extraction, and detecting Reddit's in-app navigation.
- `popup.html`, `popup.js`: settings and logs.

## Tests

```sh
node --test tests/*.test.js
```
