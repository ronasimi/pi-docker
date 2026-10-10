#!/usr/bin/env python3
"""Persist a verified Qwen profile or switch/restore only saved model selections."""
from datetime import datetime, timezone
from pathlib import Path
import copy
import json
import os
import re
import sys
import tempfile
import statistics

MODELS = {
    '4b': ('qwen3.5:4b', 'qwen3.5:4b-32k'),
    'distill': ('tobestyledintro/qwen3.8-9b-distill:latest', 'tobestyledintro/qwen3.8-9b-distill:latest-32k'),
}
AGENT_SETTINGS = 'data/pi/agent/settings.json'
WEB_STATE = 'data/web/client-state.json'
TRIAL = 'data/pi/agent/model-trials/qwen-32k'
JOURNAL = TRIAL + '/selections.json'
PROFILE_FIELDS = ('name', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'compat', 'thinkingLevelMap', 'samplingParams')


def check_options():
    for name, default, minimum, maximum in [('PI_QWEN_PROBE_ROUNDS', '2', 2, 12), ('PI_QWEN_PROBE_TIMEOUT_MS', '600000', 10000, 3600000)]:
        value = os.environ.get(name) or default
        if not re.fullmatch(r'[0-9]+', value) or not minimum <= int(value) <= maximum:
            raise ValueError(f'{name} must be an integer between {minimum} and {maximum}')


def merge_compat(*values):
    merged = {}
    for value in values:
        value = value or {}
        previous = merged.copy()
        merged.update(value)
        # Pi 1.1.0 merges these compatibility objects one level deeper.
        for key in ('openRouterRouting', 'vercelGatewayRouting', 'chatTemplateKwargs', 'chatTemplateArgs'):
            if isinstance(previous.get(key), dict) or isinstance(value.get(key), dict):
                merged[key] = {**(previous.get(key) or {}), **(value.get(key) or {})}
    return merged


def effective_profile(provider, definition, override):
    result = {field: copy.deepcopy(override.get(field, definition.get(field))) for field in PROFILE_FIELDS}
    for field in ('thinkingLevelMap', 'samplingParams'):
        result[field] = {**(definition.get(field) or {}), **(override.get(field) or {})}
    result['compat'] = merge_compat(provider.get('compat'), definition.get('compat'), override.get('compat'))
    return result


def same_value(left, right):
    if type(left) is bool or type(right) is bool:
        return type(left) is type(right) and left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(same_value(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(same_value(a, b) for a, b in zip(left, right))
    return left == right


def checked_path(root, relative):
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root):
        raise ValueError('Refusing symlink or escaped destination: ' + relative)
    return path


def read_json(root, relative):
    path = checked_path(root, relative)
    return json.loads(path.read_text()) if path.exists() else {}


def write_json(root, relative, value):
    path = checked_path(root, relative)
    rendered = json.dumps(value, indent=2) + '\n'
    if path.exists() and path.read_text() == rendered:
        return
    owner_path = path if path.exists() else path.parent
    if relative.startswith('data/pi/'):
        owner_path = root / 'data/pi'
    elif relative.startswith('data/web/'):
        owner_path = root / 'data/web'
    owner = owner_path.stat() if owner_path.exists() else None
    absent = []
    parent = path.parent
    while not parent.exists():
        absent.append(parent)
        parent = parent.parent
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.geteuid() == 0 and owner:
        for parent in absent:
            os.chown(parent, owner.st_uid, owner.st_gid)
    fd, tmp = tempfile.mkstemp(prefix='.qwen-', dir=path.parent)
    try:
        if os.geteuid() == 0 and owner:
            os.fchown(fd, owner.st_uid, owner.st_gid)
        with os.fdopen(fd, 'w') as stream:
            stream.write(rendered)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def at_path(value, keys):
    for key in keys:
        if not isinstance(value, dict) or key not in value:
            return {'present': False}
        value = value[key]
    return {'present': True, 'value': copy.deepcopy(value)}


def set_path(value, keys, stored):
    parents = []
    for key in keys[:-1]:
        parents.append((value, key))
        value = value.setdefault(key, {})
    if stored['present']:
        value[keys[-1]] = copy.deepcopy(stored['value'])
    else:
        value.pop(keys[-1], None)
        for parent, key in reversed(parents):
            if parent[key]:
                break
            del parent[key]


def store_profile(root, key, receipt):
    source, model = MODELS[key]
    if receipt.get('source') != source or receipt.get('model') != model or not receipt.get('digest'):
        raise ValueError('Prepared receipt does not match the requested Qwen alias')
    profile = receipt['profile']
    if profile.get('contextWindow') != 32768 or profile.get('maxTokens') != 4096:
        raise ValueError('Qwen must retain the 32K context / 4K output budgets')
    if profile.get('compat', {}).get('thinkingFormat') != 'openai' or profile.get('thinkingLevelMap', {}).get('off') != 'none':
        raise ValueError('Qwen requires the verified Ollama thinking configuration')
    overrides = read_json(root, 'config/models-overrides.json')
    entry = overrides.setdefault('models', {}).setdefault(model, {})
    entry.pop('samplingParamsByThinkingLevel', None)
    for field in PROFILE_FIELDS:
        entry[field] = copy.deepcopy(profile[field])
    # Old modelOverrides can mask the freshly synchronized models[] profile.
    catalog = read_json(root, 'data/pi/agent/models.json')
    saved_override = catalog.get('providers', {}).get('ollama', {}).get('modelOverrides', {}).get(model)
    if saved_override is not None:
        saved_override.pop('samplingParamsByThinkingLevel', None)
        for field in PROFILE_FIELDS:
            saved_override[field] = copy.deepcopy(profile[field])
    write_json(root, 'config/models-overrides.json', overrides)
    if saved_override is not None:
        write_json(root, 'data/pi/agent/models.json', catalog)
    write_json(root, f'{TRIAL}/{key}/prepared.json', receipt)
    return {'profile': model, 'contextWindow': 32768, 'maxTokens': 4096}


def activate(root, key):
    _, model = MODELS[key]
    qualified = 'ollama/' + model
    report = read_json(root, f'{TRIAL}/{key}/probe.json')
    prepared = read_json(root, f'{TRIAL}/{key}/prepared.json')
    if report.get('status') != 'passed' or report.get('model') != model:
        raise ValueError('Activation requires a passed inference probe for this alias')
    rounds = report.get('roundsPerMode')
    if report.get('version') != 2 or type(rounds) is not int or not 2 <= rounds <= 12:
        raise ValueError('Run the updated multi-turn inference probe before activation')
    if not report.get('digest') or report['digest'] != prepared.get('digest'):
        raise ValueError('Probe digest differs from the prepared alias')
    if (report.get('contextWindow'), report.get('maxTokens'), report.get('compactionThreshold')) != (32768, 4096, 24576):
        raise ValueError('Probe budgets differ from the project budgets')
    cases = {case['thinkingLevel']: case for case in report.get('cases', [])}
    for level in ('off', 'medium'):
        case = cases.get(level, {})
        if case.get('status') != 'passed' or case.get('toolExecutions') != rounds or case.get('evidenceRetrievals') != rounds:
            raise ValueError('Both thinking modes must pass discovery, invocation and evidence retrieval')
        runtime = case.get('runtime', {})
        if runtime.get('status') != 'passed' or runtime.get('model') != model or runtime.get('contextWindow') != 32768 or runtime.get('digest') != prepared['digest']:
            raise ValueError('Both thinking modes must verify the loaded 32K context and alias digest')
        turn_reports = case.get('rounds', [])
        if len(turn_reports) != rounds or len({turn.get('toolName') for turn in turn_reports}) != rounds:
            raise ValueError('Each turn must test a different deferred schema')
        # maxSchemaCount counts all historical immutable schema messages, not
        # the authorized nine-slot lease. Enforce one *new* schema per discovery,
        # and never accept a lease over nine distinct operations.
        history = case.get('maxSchemaCount')
        if (case.get('stableDeclarations') is not True or case.get('immutableToolResults') is not True
                or type(history) is not int or not 1 <= history <= rounds
                or case.get('maxSchemasPerDiscovery') != 1
                or type(case.get('maxBufferedTools')) is not int
                or not 1 <= case['maxBufferedTools'] <= 9):
            raise ValueError('FIFO-9 schema budget, standing declarations or immutable discovery history invalid')
        for turn in turn_reports:
            if turn.get('status') != 'passed' or turn.get('toolExecutions') != 1 or turn.get('evidenceRetrievals') != 1 or turn.get('separatedThinking') is not (level != 'off'):
                raise ValueError('Every follow-up must pass structured invocation, retrieval and thinking separation')
    checked = datetime.fromisoformat(report['checkedAt'].replace('Z', '+00:00'))
    age = (datetime.now(timezone.utc) - checked).total_seconds()
    if not -300 <= age <= 3600:
        raise ValueError('Probe is stale; run setup again to test before activation')
    catalog = read_json(root, 'data/pi/agent/models.json')
    actual = next((m for m in catalog.get('providers', {}).get('ollama', {}).get('models', []) if m.get('id') == model), {})
    if (actual.get('contextWindow'), actual.get('maxTokens')) != (32768, 4096):
        raise ValueError('Synchronized alias missing or budgets changed')
    provider = catalog.get('providers', {}).get('ollama', {})
    saved_override = provider.get('modelOverrides', {}).get(model, {})
    project_override = read_json(root, 'config/models-overrides.json').get('models', {}).get(model, {})
    current = effective_profile(provider, actual, saved_override)
    next_definition = {**actual, **project_override, 'compat': merge_compat(actual.get('compat'), project_override.get('compat'))}
    upcoming = effective_profile(provider, next_definition, {**saved_override, **project_override})
    for field in PROFILE_FIELDS:
        expected = prepared['profile'].get(field)
        if field == 'compat':
            matches = all(same_value(current[field].get(key), value) and same_value(project_override.get(field, {}).get(key), value) for key, value in expected.items())
        else:
            matches = same_value(current[field], expected) and same_value(project_override.get(field), expected)
        if not matches or not same_value(current[field], report.get('testedProfile', {}).get(field)) or not same_value(upcoming[field], report.get('testedProfile', {}).get(field)):
            raise ValueError('Synchronized alias profile changed after preparation: ' + field)

    documents = {AGENT_SETTINGS: read_json(root, AGENT_SETTINGS), WEB_STATE: read_json(root, WEB_STATE)}
    originals = copy.deepcopy(documents)
    old_journal = read_json(root, JOURNAL)
    journal = copy.deepcopy(old_journal) if old_journal.get('status') == 'active' else {'version': 1, 'entries': []}
    entries = {(e['file'], tuple(e['path'])): e for e in journal['entries']}

    def change(file, path, value):
        identity = (file, tuple(path))
        before = at_path(documents[file], path)
        if before == {'present': True, 'value': value}:
            return
        entry = entries.get(identity)
        if entry is None:
            entry = {'file': file, 'path': path, 'before': before}
            journal['entries'].append(entry)
            entries[identity] = entry
        entry['after'] = copy.deepcopy(value)
        set_path(documents[file], path, {'present': True, 'value': value})

    settings = documents[AGENT_SETTINGS]
    previous = f"{settings.get('defaultProvider', '')}/{settings.get('defaultModel', '')}"
    state = documents[WEB_STATE]
    prior_web = state.get('__settings__', {}).get('defaultModel')
    replace = {previous, prior_web} | {'ollama/' + entry[1] for entry in MODELS.values()}
    change(AGENT_SETTINGS, ['defaultProvider'], 'ollama')
    change(AGENT_SETTINGS, ['defaultModel'], model)
    change(AGENT_SETTINGS, ['modelThinkingLevels', qualified], 'medium')
    if isinstance(settings.get('enabledModels'), list) and qualified not in settings['enabledModels']:
        change(AGENT_SETTINGS, ['enabledModels'], settings['enabledModels'] + [qualified])
    change(WEB_STATE, ['__settings__', 'defaultModel'], qualified)
    for client, record in state.items():
        if not isinstance(record, dict):
            continue
        current = record.get('defaultModel')
        if client != '__settings__' and isinstance(current, str) and (current in replace or current.startswith('ollama/gemma4:e4b')):
            change(WEB_STATE, [client, 'defaultModel'], qualified)
        for cwd, value in list(record.get('projectModels', {}).items()):
            if isinstance(value, str) and (value in replace or value.startswith('ollama/gemma4:e4b')):
                change(WEB_STATE, [client, 'projectModels', cwd], qualified)
    change(WEB_STATE, ['__settings__', 'projectModels', '/workspace'], qualified)
    journal.update(status='active', model=model, selectedAt=datetime.now(timezone.utc).isoformat())
    # Journal the baseline before replacing either settings file. All writes are
    # made with Pi stopped; rollback therefore cannot overwrite a live UI write.
    try:
        write_json(root, JOURNAL, journal)
        for file, value in documents.items():
            write_json(root, file, value)
    except Exception:
        for file, value in originals.items():
            write_json(root, file, value)
        write_json(root, JOURNAL, old_journal)
        raise
    return {'selected': qualified, 'restoreEntries': len(journal['entries'])}


def trial_status(root, selector):
    """Read recorded evidence without contacting Docker or writing files."""
    summaries = []
    for key in list(MODELS) if selector == 'all' else [selector]:
        if key not in MODELS:
            raise ValueError('Use all, 4b or distill')
        report = read_json(root, f'{TRIAL}/{key}/probe.json')
        prepared = read_json(root, f'{TRIAL}/{key}/prepared.json')
        age = None
        if report.get('checkedAt'):
            checked = datetime.fromisoformat(report['checkedAt'].replace('Z', '+00:00'))
            if checked.tzinfo is None:
                raise ValueError('Probe timestamp must include a timezone')
            age = round((datetime.now(timezone.utc) - checked).total_seconds())
        def metrics(case):
            turns = case.get('rounds', [])
            def numbers(field):
                return [turn[field] for turn in turns if type(turn.get(field)) in (int, float)]
            first = numbers('firstTokenMs')
            return {
                'thinkingLevel': case.get('thinkingLevel'), 'status': case.get('status', 'failed'),
                'completedTurns': len(turns),
                'medianFirstTokenMs': statistics.median(first) if first else None,
                'peakRequestBytes': max(numbers('peakRequestBytes'), default=None),
                'peakReportedPromptTokens': max(numbers('reportedPromptTokens'), default=None),
                'reportedCachedTokens': sum(numbers('reportedCachedTokens')),
                'generatedTokens': sum(numbers('generatedTokens')),
                'completedTurnElapsedMs': sum(numbers('elapsedMs')),
                'recordedRuntime': case.get('runtime'),
            }
        modes = [metrics(case) for case in report.get('cases', [])]
        failure = report.get('failure')
        if failure:
            modes.append(metrics({**failure, 'status': 'failed'}))
        summaries.append({
            'key': key, 'model': MODELS[key][1], 'status': report.get('status', 'not_tested'),
            'reportVersion': report.get('version'), 'checkedAt': report.get('checkedAt'),
            'ageSeconds': age,
            'withinActivationAgeLimit': age is not None and -300 <= age <= 3600,
            'digestMatchesPreparation': bool(report.get('digest')) and report.get('digest') == prepared.get('digest'),
            'modes': modes, 'failure': failure or report.get('error'),
        })
    return {'note': 'Recorded results only; this does not verify current model allocation, profiles or activation eligibility.', 'trials': summaries}


def compare_trials(root):
    """Compare historical 4B/distillation probe evidence, with no model I/O.

    Only like-for-like, passing and recently recorded tests can supply deltas.
    This command is diagnostic; activation independently checks current state.
    """
    summaries = trial_status(root, 'all')['trials']
    by_key = {item['key']: item for item in summaries}
    left, right = by_key['4b'], by_key['distill']
    blockers = []
    for candidate in (left, right):
        key = candidate['key']
        if candidate['status'] != 'passed' or candidate['reportVersion'] != 2:
            blockers.append(f'{key}: no complete v2 passing probe')
        if not candidate['withinActivationAgeLimit']:
            blockers.append(f'{key}: probe is stale or has no reliable timestamp')
        if not candidate['digestMatchesPreparation']:
            blockers.append(f'{key}: prepared and probed digests do not match')
        modes = {mode.get('thinkingLevel'): mode for mode in candidate['modes']}
        for level in ('off', 'medium'):
            mode = modes.get(level)
            if not mode or mode.get('status') != 'passed' or mode.get('completedTurns', 0) < 2:
                blockers.append(f'{key}: {level} missing two passing turns')
            elif (mode.get('recordedRuntime') or {}).get('contextWindow') != 32768:
                blockers.append(f'{key}: {level} has no verified 32K loaded allocation')
    raw = {key: read_json(root, f'{TRIAL}/{key}/probe.json') for key in MODELS}
    rounds = {key: report.get('roundsPerMode') for key, report in raw.items()}
    if rounds['4b'] != rounds['distill'] or not isinstance(rounds['4b'], int):
        blockers.append('Candidate runs used different or unknown turn counts')
    comparable = not blockers
    metrics = ('medianFirstTokenMs', 'completedTurnElapsedMs', 'peakRequestBytes',
               'peakReportedPromptTokens', 'reportedCachedTokens', 'generatedTokens')
    modes = []
    for level in ('off', 'medium'):
        values = {}
        for key, candidate in by_key.items():
            mode = next((m for m in candidate['modes'] if m.get('thinkingLevel') == level and m.get('status') == 'passed'), None)
            values[key] = {name: mode.get(name) if mode else None for name in metrics}
        delta = None
        if comparable:
            delta = {name: round(values['distill'][name] - values['4b'][name], 2)
                     if all(isinstance(values[key][name], (int, float)) and not isinstance(values[key][name], bool) for key in MODELS)
                     else None for name in metrics}
        modes.append({'thinkingLevel': level, '4b': values['4b'], 'distill': values['distill'],
                      'distillMinus4b': delta})
    return {
        'comparable': comparable,
        'blockers': blockers,
        'roundsPerMode': rounds,
        'modes': modes,
        'notes': [
            'Historical evidence only; current activation eligibility requires its own checks.',
            'Positive distillMinus4b latency/request-byte values mean the distillation reported a larger value.',
            'The first-event time includes text, reasoning or tool-call deltas and is not necessarily the first visible token.',
            'Reported cache-token accounting may be unavailable; zero does not establish a cache miss.',
            'One probe cannot establish a production performance or model-quality winner.',
        ],
    }


def restore(root):
    journal = read_json(root, JOURNAL)
    if journal.get('status') != 'active':
        return {'restored': 0, 'keptManualChanges': 0}
    documents = {AGENT_SETTINGS: read_json(root, AGENT_SETTINGS), WEB_STATE: read_json(root, WEB_STATE)}
    restored = skipped = 0
    for entry in reversed(journal['entries']):
        file = entry['file']
        if file not in documents:
            raise ValueError('Invalid selection journal file')
        if at_path(documents[file], entry['path']) == {'present': True, 'value': entry['after']}:
            set_path(documents[file], entry['path'], entry['before'])
            restored += 1
        else:
            skipped += 1
    for file, value in documents.items():
        write_json(root, file, value)
    journal.update(status='restored', restoredAt=datetime.now(timezone.utc).isoformat())
    write_json(root, JOURNAL, journal)
    return {'restored': restored, 'keptManualChanges': skipped}


if __name__ == '__main__':
    try:
        mode = sys.argv[1]
        if mode == 'check-options':
            check_options()
            sys.exit(0)
        root = Path(sys.argv[2]).expanduser().resolve()
        if not (root / 'compose.yaml').is_file():
            raise ValueError('Expected a pi-docker checkout with compose.yaml')
        key = sys.argv[3] if len(sys.argv) > 3 else '4b'
        if mode == 'restore':
            result = restore(root)
        elif mode == 'status':
            result = trial_status(root, key)
        elif mode == 'compare':
            result = compare_trials(root)
        elif key not in MODELS:
            raise ValueError('Use Qwen model key 4b or distill')
        elif mode == 'profile':
            result = store_profile(root, key, json.load(sys.stdin))
        elif mode == 'activate':
            result = activate(root, key)
        else:
            raise ValueError('Use profile, activate or restore')
        print(json.dumps(result, indent=2 if mode in ('status', 'compare') else None))
    except (ValueError, KeyError, OSError) as error:
        print('[qwen] ' + str(error), file=sys.stderr)
        sys.exit(1)
