const params = new URLSearchParams(window.location.search);
const version = params.get('version') || 'unknown';

const versionNode = document.getElementById('app-version');
if (versionNode) {
  versionNode.textContent = version;
}
