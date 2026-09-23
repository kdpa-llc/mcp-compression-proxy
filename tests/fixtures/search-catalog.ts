/**
 * A realistic multi-server catalog and labelled queries for measuring tool
 * search. Descriptions paraphrase common MCP reference servers; queries are
 * phrased the way an agent asks, deliberately often without the tool's own
 * words. Shared by the ranking tests and scripts/eval-search.mjs.
 */

export interface FixtureTool {
  server: string;
  tool: string;
  description: string;
}

export const SEARCH_CATALOG: FixtureTool[] = [
  { server: 'filesystem', tool: 'read_file', description: 'Read the complete contents of a file from the file system. Handles various text encodings.' },
  { server: 'filesystem', tool: 'read_multiple_files', description: 'Read the contents of multiple files simultaneously. More efficient than reading files one by one.' },
  { server: 'filesystem', tool: 'write_file', description: 'Create a new file or completely overwrite an existing file with new content.' },
  { server: 'filesystem', tool: 'edit_file', description: 'Make line-based edits to a text file. Each edit replaces exact line sequences with new content.' },
  { server: 'filesystem', tool: 'create_directory', description: 'Create a new directory or ensure a directory exists. Can create multiple nested directories in one operation.' },
  { server: 'filesystem', tool: 'list_directory', description: 'Get a detailed listing of all files and directories in a specified path.' },
  { server: 'filesystem', tool: 'directory_tree', description: 'Get a recursive tree view of files and directories as a JSON structure.' },
  { server: 'filesystem', tool: 'move_file', description: 'Move or rename files and directories.' },
  { server: 'filesystem', tool: 'search_files', description: 'Recursively search for files and directories matching a pattern.' },
  { server: 'filesystem', tool: 'get_file_info', description: 'Retrieve detailed metadata about a file or directory: size, creation time, last modified time, permissions.' },
  { server: 'github', tool: 'create_issue', description: 'Create a new issue in a GitHub repository.' },
  { server: 'github', tool: 'list_issues', description: 'List issues in a GitHub repository with filtering options by state, labels and assignee.' },
  { server: 'github', tool: 'update_issue', description: 'Update an existing issue in a GitHub repository: title, body, state, labels.' },
  { server: 'github', tool: 'add_issue_comment', description: 'Add a comment to an existing issue.' },
  { server: 'github', tool: 'create_pull_request', description: 'Create a new pull request in a GitHub repository.' },
  { server: 'github', tool: 'list_pull_requests', description: 'List and filter repository pull requests.' },
  { server: 'github', tool: 'merge_pull_request', description: 'Merge a pull request.' },
  { server: 'github', tool: 'search_code', description: 'Search for code across GitHub repositories.' },
  { server: 'github', tool: 'search_repositories', description: 'Search for GitHub repositories by name, topic or description.' },
  { server: 'github', tool: 'get_file_contents', description: 'Get the contents of a file or directory from a GitHub repository.' },
  { server: 'github', tool: 'create_branch', description: 'Create a new branch in a GitHub repository.' },
  { server: 'github', tool: 'list_commits', description: 'Get a list of commits of a branch in a GitHub repository.' },
  { server: 'slack', tool: 'post_message', description: 'Post a new message to a Slack channel.' },
  { server: 'slack', tool: 'reply_to_thread', description: 'Reply to a specific message thread in Slack.' },
  { server: 'slack', tool: 'get_channel_history', description: 'Get recent messages from a channel.' },
  { server: 'slack', tool: 'list_channels', description: 'List public channels in the workspace.' },
  { server: 'slack', tool: 'add_reaction', description: 'Add an emoji reaction to a message.' },
  { server: 'slack', tool: 'get_users', description: 'Get a list of all users in the workspace with their basic profile information.' },
  { server: 'calendar', tool: 'create_event', description: 'Create a calendar event with a title, start and end time, and attendees.' },
  { server: 'calendar', tool: 'list_events', description: 'List upcoming events on the calendar within a time range.' },
  { server: 'calendar', tool: 'delete_event', description: 'Delete an event from the calendar.' },
  { server: 'calendar', tool: 'find_free_time', description: 'Find open time slots when all attendees are available.' },
  { server: 'fetch', tool: 'fetch', description: 'Fetches a URL from the internet and extracts its contents as markdown.' },
  { server: 'postgres', tool: 'query', description: 'Run a read-only SQL query against the connected database.' },
  { server: 'postgres', tool: 'list_tables', description: 'List the tables in the connected database schema.' },
  { server: 'git', tool: 'git_status', description: 'Shows the working tree status.' },
  { server: 'git', tool: 'git_diff', description: 'Shows differences between branches or commits.' },
  { server: 'git', tool: 'git_commit', description: 'Records changes to the repository.' },
  { server: 'git', tool: 'git_log', description: 'Shows the commit logs.' },
  { server: 'memory', tool: 'create_entities', description: 'Create multiple new entities in the knowledge graph.' },
  { server: 'memory', tool: 'search_nodes', description: 'Search for nodes in the knowledge graph based on a query.' },
  { server: 'time', tool: 'get_current_time', description: 'Get the current time in a specific timezone.' },
  { server: 'time', tool: 'convert_time', description: 'Convert time between timezones.' },
];

export interface FixtureQuery {
  query: string;
  expected: string;
}

/** `expected` is `server/tool`. */
export const SEARCH_QUERIES: FixtureQuery[] = [
  { query: 'show folder contents', expected: 'filesystem/list_directory' },
  { query: 'rename a file', expected: 'filesystem/move_file' },
  { query: 'save text to disk', expected: 'filesystem/write_file' },
  { query: 'make a new folder', expected: 'filesystem/create_directory' },
  { query: 'how big is this file', expected: 'filesystem/get_file_info' },
  { query: 'change a few lines in a config file', expected: 'filesystem/edit_file' },
  { query: 'open a bug report', expected: 'github/create_issue' },
  { query: 'which PRs are open', expected: 'github/list_pull_requests' },
  { query: 'find where a function is defined in the repo', expected: 'github/search_code' },
  { query: 'comment on an issue', expected: 'github/add_issue_comment' },
  { query: 'merge the PR', expected: 'github/merge_pull_request' },
  { query: 'recent commits on main', expected: 'github/list_commits' },
  { query: 'post a note to the team chat', expected: 'slack/post_message' },
  { query: 'read the latest messages in #general', expected: 'slack/get_channel_history' },
  { query: 'react with a thumbs up', expected: 'slack/add_reaction' },
  { query: 'who is in the workspace', expected: 'slack/get_users' },
  { query: 'what meetings do I have tomorrow', expected: 'calendar/list_events' },
  { query: 'schedule a sync with bob on friday', expected: 'calendar/create_event' },
  { query: 'cancel my 3pm meeting', expected: 'calendar/delete_event' },
  { query: 'when is everyone available', expected: 'calendar/find_free_time' },
  { query: 'download a web page', expected: 'fetch/fetch' },
  { query: 'look up rows in the users table', expected: 'postgres/query' },
  { query: 'what tables exist', expected: 'postgres/list_tables' },
  { query: 'uncommitted changes', expected: 'git/git_status' },
  { query: 'what time is it in Tokyo', expected: 'time/get_current_time' },
  { query: 'convert 9am PST to CET', expected: 'time/convert_time' },
  { query: 'remember a fact about a person', expected: 'memory/create_entities' },
  { query: 'read_file', expected: 'filesystem/read_file' },
  { query: 'list_issues', expected: 'github/list_issues' },
  { query: 'search code', expected: 'github/search_code' },
];
