const params = new URLSearchParams(window.location.search);
const version = params.get('version') || 'unknown';
const github = params.get('github') || '';

const versionNode = document.getElementById('app-version');
if (versionNode) {
  versionNode.textContent = version;
}

const githubLink = document.getElementById('project-github-link');
if (githubLink) {
  githubLink.textContent = github;
  githubLink.setAttribute('href', github);
}
