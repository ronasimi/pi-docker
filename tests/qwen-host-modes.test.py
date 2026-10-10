"""Host mode regressions; no Pi SDK, Docker daemon or model weights required."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone, timedelta

SOURCE = Path(__file__).resolve().parents[1]


class HostModes(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'scripts').mkdir()
        (self.root / 'bin').mkdir()
        (self.root / 'compose.yaml').write_text('services: {}\n')
        for name in ('setup-qwen.sh', 'configure-qwen-trial.py'):
            shutil.copy2(SOURCE / 'scripts' / name, self.root / 'scripts' / name)
        (self.root / 'scripts/validate-image.sh').write_text('#!/bin/bash\nexit 0\n')
        docker = self.root / 'bin/docker'
        docker.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
with pathlib.Path('calls.jsonl').open('a') as stream:
    stream.write(json.dumps(sys.argv[1:]) + '\\n')
if any('prepare-qwen' in arg for arg in sys.argv) or sys.argv[2] in ('stop', 'up'):
    sys.exit(93)
if any('probe-qwen' in arg for arg in sys.argv) and sys.argv[-1] == os.environ.get('FAIL_MODEL'):
    sys.exit(1)
''')
        docker.chmod(0o755)
        self.env = {**os.environ, 'PATH': str(self.root / 'bin') + os.pathsep + os.environ['PATH']}
        self.write('data/pi/agent/settings.json', {'defaultModel': 'original'})
        self.write('config/models-overrides.json', {'unchanged': True})

    def write(self, relative, value):
        file = self.root / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(value))

    def run_mode(self, *args, wrapper=False, **env):
        command = ['bash', str(SOURCE / 'setup-qwen.sh'), str(self.root)] if wrapper else ['bash', str(self.root / 'scripts/setup-qwen.sh')]
        return subprocess.run(command + list(args), capture_output=True, text=True, env={**self.env, **env})

    def snapshot(self):
        return {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}

    def test_status_is_read_only_without_docker_and_ignores_probe_options(self):
        before = self.snapshot()
        for wrapper in (False, True):
            result = self.run_mode('--status', wrapper=wrapper, PI_QWEN_PROBE_ROUNDS='invalid')
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads(result.stdout)
            self.assertEqual([r['status'] for r in data['trials']], ['not_tested', 'not_tested'])
        self.assertEqual(before, self.snapshot())

    def test_summary_retains_partial_metrics_and_stale_state(self):
        folder = 'data/pi/agent/model-trials/qwen-32k/4b/'
        self.write(folder + 'prepared.json', {'digest': 'one'})
        self.write(folder + 'probe.json', {
            'version': 2, 'status': 'failed', 'digest': 'two',
            'checkedAt': (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat(),
            'cases': [{'thinkingLevel': 'off', 'status': 'passed', 'rounds': [
                {'firstTokenMs': 100, 'peakRequestBytes': 900, 'elapsedMs': 200},
                {'firstTokenMs': 300, 'peakRequestBytes': 1200, 'elapsedMs': 500}]}],
            'failure': {'thinkingLevel': 'medium', 'phase': 'inference', 'error': 'timeout', 'rounds': [{'firstTokenMs': None}]},
        })
        result = self.run_mode('4b', '--status')
        self.assertEqual(result.returncode, 0, result.stderr)
        trial = json.loads(result.stdout)['trials'][0]
        self.assertFalse(trial['withinActivationAgeLimit'])
        self.assertFalse(trial['digestMatchesPreparation'])
        self.assertEqual(trial['modes'][0]['medianFirstTokenMs'], 200)
        self.assertEqual(trial['modes'][0]['peakRequestBytes'], 1200)
        self.assertEqual(trial['modes'][0]['completedTurnElapsedMs'], 700)
        self.assertIsNone(trial['modes'][1]['medianFirstTokenMs'])
        self.assertEqual(trial['failure']['phase'], 'inference')

    def test_compare_read_only_blocks_missing_probes_and_does_not_use_docker(self):
        before = self.snapshot()
        for wrapper in (False, True):
            result = self.run_mode('--compare', wrapper=wrapper, PI_QWEN_PROBE_ROUNDS='invalid')
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertFalse(report['comparable'])
            self.assertIn('no complete v2 passing probe', ' '.join(report['blockers']))
            self.assertIsNone(report['modes'][0]['distillMinus4b'])
        self.assertEqual(before, self.snapshot())

    def test_compare_requires_like_for_like_and_reports_deltas(self):
        for key, event_ms in [('4b', 110), ('distill', 240)]:
            prefix = f'data/pi/agent/model-trials/qwen-32k/{key}/'
            self.write(prefix + 'prepared.json', {'digest': key})
            self.write(prefix + 'probe.json', {
                'status': 'passed', 'version': 2, 'roundsPerMode': 2, 'digest': key,
                'checkedAt': datetime.now(timezone.utc).isoformat(),
                'cases': [
                    {'thinkingLevel': level, 'status': 'passed', 'runtime': {'contextWindow': 32768},
                     'rounds': [{'firstTokenMs': event_ms, 'peakRequestBytes': 1400,
                                 'elapsedMs': event_ms * 2, 'reportedPromptTokens': 300,
                                 'reportedCachedTokens': 0, 'generatedTokens': 40}] * 2}
                    for level in ('off', 'medium')],
            })
        before = self.snapshot()
        result = self.run_mode('--compare')
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertTrue(data['comparable'], data['blockers'])
        self.assertEqual(data['modes'][0]['distillMinus4b']['medianFirstTokenMs'], 130)
        self.assertEqual(data['modes'][1]['distillMinus4b']['completedTurnElapsedMs'], 520)
        self.assertEqual(before, self.snapshot())
        self.write('data/pi/agent/model-trials/qwen-32k/distill/probe.json', {'status': 'failed'})
        changed = json.loads(self.run_mode('--compare').stdout)
        self.assertFalse(changed['comparable'])
        self.assertIsNone(changed['modes'][0]['distillMinus4b'])

    def test_probe_continues_after_failure_without_preparation_or_restart(self):
        before = self.snapshot()
        result = self.run_mode('all', '--probe', FAIL_MODEL='4b')
        self.assertEqual(result.returncode, 1, result.stderr)
        calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
        probes = [call for call in calls if any('probe-qwen' in arg for arg in call)]
        self.assertEqual([call[-1] for call in probes], ['4b', 'distill'])
        after = self.snapshot()
        after.pop('calls.jsonl')
        self.assertEqual(before, after)

    def test_wrapper_probe_delegates_without_deploying(self):
        result = self.run_mode('distill', '--probe', wrapper=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = (self.root / 'calls.jsonl').read_text()
        self.assertIn('probe-qwen-trial.mjs', calls)
        self.assertNotIn('prepare-qwen', calls)

    def test_invalid_probe_options_fail_before_docker(self):
        for wrapper in (False, True):
            result = self.run_mode('all', '--probe', wrapper=wrapper, PI_QWEN_PROBE_ROUNDS='1')
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'calls.jsonl').exists())

    def test_corrupt_report_errors_without_writes(self):
        file = self.root / 'data/pi/agent/model-trials/qwen-32k/4b/probe.json'
        file.parent.mkdir(parents=True)
        file.write_text('{broken')
        before = self.snapshot()
        result = self.run_mode('--status')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(before, self.snapshot())


if __name__ == '__main__':
    unittest.main()
