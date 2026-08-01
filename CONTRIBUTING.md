# Contributing

## Branch protection

**`main` is protected.** Never commit or push directly to `main`.

1. Create a branch from up-to-date `main`  
   `git checkout main && git pull && git checkout -b feature/your-change`
2. Make changes, run `npm test` and `npm run test:workers` as needed
3. Push the branch and open a **pull request**
4. Merge only via PR (squash or merge — team preference)

Agents and automation should follow the same rule: work on a branch and open a PR.
