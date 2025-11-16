# Security Policy

## Supported Versions

We release patches for security vulnerabilities for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

We take the security of MCP Tool Aggregator seriously. If you discover a security vulnerability, please follow these steps:

### How to Report

**Please do NOT open a public issue.**

Instead:

1. **Email**: Report vulnerabilities via GitHub's private vulnerability reporting feature, or
2. **GitHub Issues**: Create a new issue marked with the "security" label and we'll address it privately

### What to Include

When reporting a vulnerability, please include:

- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Suggested fix (if you have one)
- Your contact information

### Response Timeline

- **Acknowledgment**: We aim to acknowledge receipt within 48 hours
- **Initial Assessment**: We'll provide an initial assessment within 5 business days
- **Updates**: We'll keep you informed of our progress
- **Resolution**: We aim to release a fix as soon as possible, depending on complexity

### Disclosure Policy

- Please give us reasonable time to fix the issue before public disclosure
- We'll credit you in the security advisory (unless you prefer to remain anonymous)
- We'll coordinate with you on the disclosure timeline

## Security Best Practices

When using MCP Tool Aggregator:

### For Users

1. **Keep Updated**: Always use the latest version
2. **Review Server Configs**: Carefully review server configurations before use
3. **Trust Sources**: Only aggregate tools from trusted MCP servers
4. **Environment Variables**: Protect any sensitive environment variables (API keys, tokens)
5. **File Permissions**: Ensure configuration files have appropriate permissions

### For Server Operators

1. **No Secrets in Code**: Never commit API keys, passwords, or secrets
2. **Environment Variables**: Use environment variables for sensitive data
3. **Access Control**: Configure underlying MCP servers with appropriate access controls
4. **Monitor Logs**: Review logs for suspicious activity
5. **Principle of Least Privilege**: Only enable servers you need

## Known Security Considerations

### Server Aggregation

- The aggregator connects to multiple MCP servers with their configured permissions
- Each underlying server has its own security model and access controls
- Review the security implications of each aggregated server
- Servers run with the permissions of the user who starts them

### Compression Cache

- Compressed descriptions are stored in-memory
- Cache is cleared on server restart
- No persistent storage of sensitive data

### Session Management

- Sessions expire after 30 minutes of inactivity
- Session IDs are randomly generated
- Sessions are independent and isolated

### Environment

- The server runs with the permissions of the user who starts it
- Environment variables are accessible to the server
- Use appropriate security practices for your environment

## Security Updates

Security updates will be:
- Released as patch versions (e.g., 0.1.1)
- Documented in CHANGELOG.md
- Announced in the release notes
- Tagged with [SECURITY] in commit messages

## Contact

For security concerns, please use GitHub's security features or create a private issue.

Thank you for helping keep MCP Tool Aggregator secure!
