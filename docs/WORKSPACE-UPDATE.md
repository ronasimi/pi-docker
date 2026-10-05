# Repository-local workspace — 2026-10-04

Pi now mounts ./workspace from the pi-docker repository at /workspace, replacing the entire ~/Projects mount. Its Web UI working directory remains /workspace. Initialization and upgrade create the directory; workspace contents are excluded from Git and Docker build context except the tracked .gitkeep marker.

The complete deployment runs configure-pi-workspace.py before rebuilding/recreating MCP services. It creates the directory, backs up the gateway .env, changes only MCP_WORKSPACE_PATH to the resolved Pi repository workspace, and exports that value for deployment. System, Security and configured Google services use the same path. Existing files in the old workspace are left in place. Use a new conversation after deployment.

Security results use the Pi reader group (1000), setgid result directories and group-readable observation/map files. The Security service joins that supplementary group. Provisioning changes only application result directories; it does not recursively modify old data or relax the entire workspace. New workspace ownership is set to UID/GID 1000 when installation runs as root. Installations with UID remapping or filesystem restrictions still need a successful runtime write check.

Validation: two workspace configuration tests passed (settings preservation, backups, repeated installation and symlink rejection). The ownership call is mocked because this executor rejects changing ownership to UID 1000. Existing gateway suite passed 56 tests with one UID-switch test skipped. Shell syntax checked. Live Docker deployment unavailable.

Run review: the E4B attachment arrived during implementation. See E4B-RUN-REVIEW.md in the complete bundle for confirmed improvements and remaining failures.
