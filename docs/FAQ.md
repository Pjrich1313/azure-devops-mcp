# Frequently Asked Questions

Before you get started, ensure you follow the steps in the `README.md` file. This will help you get up and running and connected to your Azure DevOps organization.

## Does the MCP Server support both Azure DevOps Services and on-premises deployments?

This MCP Server supports only Azure DevOps Services. Several required API endpoints are not yet available for on-premises deployments. We currently do not have plans to support Azure DevOps on-prem.

## Can I connect to more than one organization at a time?

No, you can connect to only one organization at a time. However, you can switch organizations as needed.

## Can I set a default project instead of fetching the list every time?

Currently, you need to fetch the list of projects so the LLM has context about the project name or ID. We plan to improve this experience in the future by leveraging prompts. In the meantime, you can set a default project name in your `copilot-instructions.md` file.

## Are PAT's supported?

Yes! Personal Access Tokens (PATs) are supported via the `pat` authentication type. See the [Authentication Methods](./GETTINGSTARTED.md#-authentication-methods) section in the Getting Started guide for setup instructions, including the required base64 encoding format.

## Is there a remote supported version of the MCP Server?

Yes. The Azure DevOps Remote MCP Server is available in public preview. For the recommended hosted setup, see the [Remote MCP Server section in the README](../README.md#-remote-mcp-server-recommended).

## Which setup should I choose: remote or local?

Start with the remote server unless you specifically need a local `stdio` process, client-side domains, or custom local authentication behavior. If you need the local server, follow the [Quick Start](../README.md#-quick-start) and [Getting Started](./GETTINGSTARTED.md) guides.

## What environment variables do I need for local setup?

That depends on the authentication mode:

- `interactive` and `azcli`: no required server-specific environment variables
- `envvar`: set `ADO_MCP_AUTH_TOKEN`
- `pat`: set `PERSONAL_ACCESS_TOKEN` to the base64-encoded `<email>:<pat>` value

The optional `coins` domain also uses its own environment variables such as `COINBASE_API_KEY`, `COINBASE_API_SECRET`, `COINBASE_API_PASSPHRASE`, `ETHEREUM_RPC_URL`, and `BITCOIN_API_BASE_URL`.

## Are personal accounts supported?

Unfortunately, personal accounts are not supported. To maintain a higher level of authentication and security, your account must be backed by Entra ID. If you receive an error message like this, it means you are using a personal account.

![image of login error for personal accounts](./media/personal-accounts-error.png)

## When will a remote Azure DevOps MCP Server be available?

The remote server is already available in public preview. Use the hosted configuration from the [README](../README.md#-remote-mcp-server-recommended) for the simplest onboarding path.

## What is the `coins` domain for?

The `coins` domain is an optional Pamela Menopool extension that adds cryptocurrency balance and payout helpers. It is not required for regular Azure DevOps usage, so most users can leave it disabled.
