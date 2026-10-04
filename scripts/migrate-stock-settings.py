#!/usr/bin/env python3
"""One-time, host-side migration. Preserve unrelated settings and user state."""
import argparse
import json
import os
from pathlib import Path
import re
import tempfile


def read_object(path):
    value = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(value, dict):
        raise ValueError(f'{path} must contain a JSON object')
    return value


def migrate_settings(settings, defaults):
    result = dict(settings)
    result['defaultTools'] = defaults['defaultTools']
    legacy = re.compile(r'pi-mcp-adapter|(?:pi-)?mcp-gate(?:/|$)')
    extensions = settings.get('extensions', [])
    packages = settings.get('packages', [])
    if not isinstance(extensions, list) or not isinstance(packages, list):
        raise ValueError('extensions and packages must be arrays')
    result['extensions'] = [x for x in extensions if not (
        isinstance(x, str) and (x in ['-builtin:mcp', '-builtin:tool-search'] or legacy.search(x))
    )]
    result['packages'] = [x for x in packages if not legacy.search(
        x if isinstance(x, str) else str(x.get('source', '')) if isinstance(x, dict) else ''
    )]
    return result


def migrate_web(state, defaults):
    result = dict(state)
    global_state = dict(result.get('__settings__', {}))
    settings = dict(global_state.get('settings', {}))
    disabled = settings.get('disabledAgentTools', [])
    if not isinstance(disabled, list):
        raise ValueError('disabledAgentTools must be an array')
    core = {'read', 'bash', 'edit', 'write', 'tool_search'}
    settings['disabledAgentTools'] = sorted((set(disabled) | set(defaults['disabledAgentTools'])) - core)
    for key in ('terminalToolsEnabled', 'terminalBash', 'editSoftEnabled', 'questionnaireEnabled'):
        settings[key] = False
    # Standard permits upstream tool_search and loaded MCP schemas; the code
    # and minimal presets are fixed allowlists that exclude them.
    settings['defaultAgentPreset'] = 'standard'
    global_state['settings'] = settings
    result['__settings__'] = global_state
    return result


def atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    owner = path.stat() if path.exists() else path.parent.stat()
    fd, tmp = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(text)
        os.chmod(tmp, 0o600)
        if os.geteuid() == 0:
            os.chown(tmp, owner.st_uid, owner.st_gid)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    settings_path = root / 'data/pi/agent/settings.json'
    web_path = root / 'data/web/client-state.json'
    settings = migrate_settings(read_object(settings_path), read_object(root / 'config/settings.json'))
    web = migrate_web(read_object(web_path), read_object(root / 'config/web-settings.json'))
    env_path = root / '.env'
    env = env_path.read_text() if env_path.exists() else (root / '.env.example').read_text()
    for key, value in [('PI_VERSION', '1.0.0'), ('PI_WEB_UI_VERSION', '0.97.0')]:
        pattern = rf'(?m)^(?:export\s+)?{key}=.*$'
        line = f'{key}={value}'
        env = re.sub(pattern, line, env) if re.search(pattern, env) else env.rstrip() + '\n' + line + '\n'
    if args.check:
        print('Migration inputs are valid.')
        return
    for path, value in [(settings_path, settings), (web_path, web)]:
        atomic_write(path, json.dumps(value, indent=2) + '\n')
    atomic_write(env_path, env)
    print('Migrated Pi/Web UI tool settings; sessions and unrelated settings retained.')


if __name__ == '__main__':
    main()
