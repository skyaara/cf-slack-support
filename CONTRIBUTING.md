# Contributing

## Branch protection

**`main` is protected.** Never commit or push directly to `main`.

1. Create a branch from up-to-date `main`  
   `git checkout main && git pull && git checkout -b feature/your-change`
2. Make changes, run `npm test` and `npm run test:workers` as needed
3. Push the branch and open a **pull request**
4. Merge only via PR — **squash merge is the only allowed method** (repo setting).
   Prefer [Conventional Commits](https://www.conventionalcommits.org/) for the PR title
   (it becomes the squash commit subject), e.g. `feat: add typing indicators`.

Agents and automation should follow the same rule: work on a branch and open a PR.
