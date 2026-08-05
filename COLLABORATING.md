# Collaborating on Wordless

This private repository is an editable collaboration copy. It is deliberately
not connected to the currently published Wordless website. Changes here do not
alter that release unless the owner separately reviews and deploys them.

## Start locally

```sh
uv sync --frozen --extra test
npm --prefix console ci
uv run python scripts/run_wordless.py
```

Open `http://127.0.0.1:3000/live`. Press Ctrl-C in the launcher terminal to
stop both local services.

For public-site-only work:

```sh
cd public-site
npm ci
npm run dev
```

## Make a change

Never commit directly to `main`. Create a focused branch:

```sh
git switch main
git pull --ff-only
git switch -c feature/short-description
```

Run the relevant tests, commit the intended files, push the branch, and open a
pull request. The repository owner reviews and merges accepted work.

Do not commit `.env` files, credentials, customer data, generated audit output,
model caches, dependency folders, or a Sites `.openai/hosting.json` file. Use
the checked-in example environment files and synthetic fixtures only.

## Release boundary

The tag `current-release-2026-08-04` records the protected starting snapshot.
The existing production site remains a separate deployed version. A pull
request merge does not publish a website or connect a Zendesk tenant.
