# Website hosting

The documentation website is hosted on GitHub Pages at
<https://awerner.github.io/pi-mistral-native/>, deployed automatically from
the repository. The site is an Astro/Starlight project in
[`website/`](../../website/) that ingests the repository docs (`docs/**/*.md`
and `README.md`) as a content collection — the docs remain the single
source of truth; the website build verifies them (page count, sidebar
slugs, asset sync).

## What you get

- A public documentation site at
  <https://awerner.github.io/pi-mistral-native/> on every push to `main`
  that changes `website/`, `docs/`, `assets/`, or `README.md`.
- A sitemap and canonical URLs under the GitHub Pages base path
  (`/pi-mistral-native/`, configured in `website/astro.config.mjs`).
- No servers to operate: GitHub Pages serves the static build output with
  HTTPS and CDN caching.

## How the deploy works

The deploy is a single GitHub Actions workflow,
[`.github/workflows/pages.yml`](../../.github/workflows/pages.yml). On push to
`main` (filtered to the paths above) it:

1. Checks out the repository and installs the website dependencies.
2. Runs the website build (`sync:assets` + `astro build`), producing the
   static site in `website/dist/`.
3. Uploads `website/dist/` with `actions/upload-pages-artifact`.
4. Deploys the artifact with `actions/deploy-pages`.

The Pages service must be enabled once in the repository's
**Settings → Pages** with the **GitHub Actions** source — an owner action
performed in the GitHub UI; nothing in the repository can enable it. While
Pages is not yet enabled, the workflow's deploy step fails after a
successful build; enabling the source makes subsequent pushes deploy
normally.

## Later phase: self-hosted deployment

A self-hosted container deployment — building the static site into a
container image and serving it behind a reverse proxy on your own
infrastructure — remains a possible later phase, independent of the GitHub
Pages setup. The build output is a plain static directory, so any static
file server works; a container image would simply wrap `website/dist/`.
Nothing in the current pipeline depends on that path; if it becomes
relevant, it can be added without changing the GitHub Pages flow.
