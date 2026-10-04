import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('migration', ROOT / 'scripts/migrate-stock-settings.py')
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class MigrationTest(unittest.TestCase):
    def test_retire_legacy_adapter_preserve_models_and_package_filters(self):
        old = {'defaultModel': 'ollama/whiterabbitneo', 'thinkingLevel': 'medium',
               'extensions': ['-builtin:mcp', '-builtin:tool-search', '/opt/pi-mcp-gate/index.ts', '/safe/local.ts'],
               'packages': ['npm:pi-mcp-adapter', {'source': 'npm:useful', 'extensions': []}]}
        defaults = {'defaultTools': ['read', 'bash', 'edit', 'write', 'tool_search']}
        new = migration.migrate_settings(old, defaults)
        self.assertEqual(new['extensions'], ['/safe/local.ts'])
        self.assertEqual(new['packages'], [{'source': 'npm:useful', 'extensions': []}])
        self.assertEqual(new['defaultModel'], old['defaultModel'])
        self.assertEqual(new['thinkingLevel'], 'medium')
        self.assertEqual(migration.migrate_settings(new, defaults), new)
        self.assertEqual(len(old['extensions']), 4)

    def test_web_state_preserves_history_and_permissions(self):
        old = {'client1': {'projects': ['/workspace/my-project'], 'model': 'local'},
               '__settings__': {'presets': [{'name': 'mine'}], 'settings': {
                   'uiLayout': 'custom', 'defaultPermissionPreset': 'read-only',
                   'disabledAgentTools': ['write', 'terminal_list']}}}
        defaults = {'disabledAgentTools': ['subagent', 'terminal_list', 'find']}
        new = migration.migrate_web(old, defaults)
        self.assertEqual(new['client1'], old['client1'])
        self.assertEqual(new['__settings__']['presets'], old['__settings__']['presets'])
        settings = new['__settings__']['settings']
        self.assertEqual(settings['defaultPermissionPreset'], 'read-only')
        self.assertEqual(settings['uiLayout'], 'custom')
        self.assertEqual(settings['disabledAgentTools'], ['find', 'subagent', 'terminal_list'])
        self.assertEqual(settings['defaultAgentPreset'], 'standard')
        self.assertEqual(migration.migrate_web(new, defaults), new)

    def test_invalid_settings_fail_before_mutation(self):
        with self.assertRaises(ValueError):
            migration.migrate_settings({'extensions': 'bad'}, {'defaultTools': []})


if __name__ == '__main__':
    unittest.main()
