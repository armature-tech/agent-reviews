# Release process

1. Merge a reviewed package change in `armature-tech/mcp-tester`.
2. **Sync agent.reviews CLI** tests the package and copies it to `armature-tech/agent-reviews`.
3. The public repository tests the mirror again.
4. The public **Publish** workflow selects the next patch version and tags the commit with it.
5. The workflow packs one exact tarball, installs it and runs the command.
6. The workflow publishes that tarball to npm with provenance.
7. The workflow creates the matching GitHub release.

A run that fails after the tag is pushed keeps that version for the commit. Rerun it: it
publishes the version if npm does not have it yet, then creates the missing release.

The first release is `0.1.0`. Later automatic releases increase the patch version.

The `npm-production` environment of the public repository must contain `NPM_TOKEN`.
If the token is absent, the workflow completes all checks but does not publish. Add the
token once, then run the public **Publish** workflow manually to release the verified commit.

Never publish from a developer computer.
