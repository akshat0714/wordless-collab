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

## Get access

This repository belongs to a personal GitHub account. GitHub gives invited
collaborators Write access to a private personal repository; Read-only access
and enforced protected branches are not available on the owner's current plan.
Invite only trusted people, and never grant Admin access or share account,
Zendesk, deployment, or API credentials.

## Make a change

Never work directly on `main`. Clone the repository and create a focused
feature branch:

```sh
git clone https://github.com/akshat0714/wordless-collab.git
cd wordless-collab
git switch main
git pull --ff-only
git switch -c feature/short-description
```

Run the relevant tests, commit the intended files, push only the feature
branch, and open a pull request into `main`. The repository owner reviews and
merges accepted work. Do not force-push, delete tags, deploy the public site, or
push directly to `main`.

Do not commit `.env` files, credentials, customer data, generated audit output,
model caches, dependency folders, or a Sites `.openai/hosting.json` file. Use
the checked-in example environment files and synthetic fixtures only.

## Release boundary

The tag `current-release-2026-08-04` records the protected starting snapshot.
The owner also keeps a separate local Git bundle outside this repository. The
existing production site remains a separate deployed version. A push or pull
request merge does not publish that website or connect a Zendesk tenant.

For enforced private-branch protection, the owner can upgrade to GitHub Pro or
move the repository to an eligible organization plan. Do not make the project
public merely to enable branch protection.
