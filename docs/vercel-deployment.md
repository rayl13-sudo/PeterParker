# GitHub Actions deployments

The `Deploy to Vercel` workflow tests the app, then builds and deploys both Vercel
projects. Pushes to `main` update production; pushes to other branches create
previews. Only repository users with write, maintain, or admin permission can
initiate or re-run deployment workflows. Pull requests from forks do not run this
deployment workflow. You can also run it from GitHub's Actions tab.

## Preserve original authorship

The deployment workflow checks out and deploys the original pushed commit. It
does not create deployment commits, change the author, or push changes back to
GitHub. The original author and existing co-author trailers remain intact;
deployment identity comes from the Vercel credential, not a rewritten Git author.

If a future workflow creates a new bot-authored commit incorporating someone's
work, its commit message must include a blank line followed by
`Co-authored-by: Original Name <original-commit-email>`, using the original Git
author's name and email. Credit each original author when incorporating multiple
authors' work. This workflow currently creates no such commits.

## Configure before merging

Both project configurations disable Vercel's automatic Git deployments. Set up
the workflow credentials before merging this change, or deployments will pause.

1. Keep two Vercel projects linked to this repository. Their Root Directory
   settings must be `backend` and `frontend`, respectively. The workflow runs the
   CLI from the repository root and pulls each project's existing settings.
2. Create GitHub environments named `production` and `preview`. Restrict the
   production environment's deployment branches to `main`. Configure these
   environment secrets in each environment:

   | Secret | Value |
   | --- | --- |
   | `VERCEL_TOKEN` | Vercel access token belonging to the dedicated deployment account |
   | `VERCEL_ORG_ID` | Team/account ID owning the Vercel projects |
   | `VERCEL_BACKEND_PROJECT_ID` | Project ID for `peterparker-mauve` |
   | `VERCEL_FRONTEND_PROJECT_ID` | Project ID for `peterparker-frontend` |

   Copy IDs from the corresponding Vercel settings; never put tokens in source
   code, workflow text, or chat. Use separate restricted preview credentials where
   your Vercel plan supports them. Environment reviewers are optional; enabling
   them intentionally makes deployments wait for approval instead of fully automatic.
3. Keep database and Supabase settings in the backend's Vercel environment
   variables. Configure both Preview and Production environments. Use a separate
   preview database to isolate test accounts and data.
4. Keep production CORS configured for the production frontend. Preview frontend
   code currently uses the production API URL in `frontend/js/config.js`; these
   frontend previews are not automatically paired with the new backend preview.
   To use an isolated preview backend, configure the preview frontend's API URL
   and the backend's exact allowed origins before using it to change data.
5. Push this configuration, then check **Actions → Deploy to Vercel**. Both test
   suites must pass before either project is deployed. Each project is a separate
   deployment; a failure in one does not roll back the other automatically.

## Restrict deployment to the bot

GitHub's `github-actions[bot]` runs the automation, but **Vercel authenticates the
account that owns `VERCEL_TOKEN`**. A GitHub token is not a Vercel deployment token.
Use a dedicated deployment identity supported by your Vercel plan if deployments
must be attributed to a bot rather than a person's Vercel account.

The repository sets `git.deploymentEnabled: false` for both projects. This blocks
the Vercel Git integration; it does not block Vercel dashboard, CLI, API, deploy
hook, rollback, or promotion operations by independently authorized identities.
To restrict those paths as well, an account/team owner must:

- Remove deployment-capable Vercel roles from human collaborators; use viewer
  roles where available. Review all inherited team and project permissions.
- Delete existing deployment hooks for both projects and remove other automation
  credentials that can deploy. Revoke unused tokens; store the bot token only in
  the protected GitHub environments.
- Protect `main` and require reviewed changes to this workflow, the Vercel
  configurations, and related deployment scripts. Restrict who can change
  GitHub environment secrets, protections, and repository settings.
- Check Vercel's audit/deployment history after setup to confirm the deployed
  identity. Anyone holding the bot token can act as that identity, so never share it.

There is no repository-level switch that can override a Vercel owner's authority.
Owners/admins retain the ability to change permissions or restore another
deployment path. Available role granularity depends on the Vercel plan.

No bot account, remote permission changes, secrets, or deployments are created by
adding these files. Those account-side settings are required to finish enforcement.

References:

- [Vercel with GitHub Actions](https://vercel.com/kb/guide/how-can-i-use-github-actions-with-vercel)
- [Disable Vercel Git deployments](https://vercel.com/docs/project-configuration/git-configuration)
- [Vercel monorepos](https://vercel.com/docs/monorepos)
- [Vercel access roles](https://vercel.com/docs/rbac/access-roles)
