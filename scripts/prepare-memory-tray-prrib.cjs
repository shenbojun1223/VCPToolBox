'use strict';

// Run from the backend root. This prepares candidates; it never edits live Agents.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const backup = path.join(root, 'backups/memory-tray-prrib-20261030');
const START = '<---VCP记忆思维区Start--->';
const END = '<---VCP记忆思维区End--->';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const specs = [
    ['Kerr', '————过往记忆与动态感知区————'],
    ['MemoMaster', '记忆大师记忆：'],
    ['Nova', '————过往记忆与动态感知区————'],
    ['Zanni', '赞妮记忆：'],
    ['Lucy', 'Lucy记忆：'],
    ['Weiming', '————过往记忆与动态感知区————'],
    ['Zhezhi', '————过往记忆与动态感知区————'],
    ['DeepSeekOfficial', null]
];
function wrapOnce(text, target, label) {
    const at = text.indexOf(target);
    assert.ok(at >= 0 && text.indexOf(target, at + target.length) < 0, label + ': target not unique');
    return text.slice(0, at) + START + target + END + text.slice(at + target.length);
}
const records = [];
for (const [name, memoryStart] of specs) {
    const rel = `Agent/${name}.txt`;
    const originalBuffer = fs.readFileSync(path.join(backup, rel));
    assert.equal(hash(fs.readFileSync(path.join(root, rel))), hash(originalBuffer), rel + ': live file changed after backup');
    const original = originalBuffer.toString('utf8');
    assert.ok(!original.includes(START) && !original.includes(END), rel + ': already marked');
    let next = original;
    if (next.includes('{{TarSysPrompt}}')) next = wrapOnce(next, '{{TarSysPrompt}}', rel + '/environment');
    if (name === 'DeepSeekOfficial') {
        next = wrapOnce(next, '今天是{{Date}},{{Today}},{{Festival}}。当前天气{{VCPWeatherInfoNow}}。', rel + '/environment');
    }
    if (memoryStart) {
        const begin = next.indexOf(memoryStart);
        const endLabel = '————过往记忆区结束————';
        const end = next.indexOf(endLabel, begin);
        assert.ok(begin >= 0 && end > begin, rel + '/memory bounds');
        next = wrapOnce(next, next.slice(begin, end + endLabel.length), rel + '/memory');
        const metaStart = '————VCP 元思维模块————';
        const metaEnd = '————VCP 元思维加载结束————';
        const mb = next.indexOf(metaStart), me = next.indexOf(metaEnd, mb);
        assert.ok(mb >= 0 && me > mb, rel + '/meta bounds');
        next = wrapOnce(next, next.slice(mb, me + metaEnd.length), rel + '/meta');
        next = wrapOnce(next, '当前时间：{{Date}} {{Time}}', rel + '/clock');
    }
    if (next.includes('{{VCPForumLister}}')) next = wrapOnce(next, '{{VCPForumLister}}', rel + '/forum list');
    if (next.includes('《《MusicDiary日记本:2::Group》》')) {
        next = wrapOnce(next, '《《MusicDiary日记本:2::Group》》', rel + '/music list');
    }
    // Exact preservation: this task may only insert the two delimiters.
    assert.equal(next.split(START).join('').split(END).join(''), original);
    const candidate = path.join(backup, 'candidates', rel);
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, next, { encoding: 'utf8', flag: 'wx' });
    records.push({
        file: rel, candidate: path.relative(backup, candidate).replaceAll('\\', '/'),
        before: hash(originalBuffer), after: hash(Buffer.from(next)),
        blocks: next.split(START).length - 1,
        originalBytes: originalBuffer.length, candidateBytes: Buffer.byteLength(next)
    });
}
fs.writeFileSync(path.join(backup, 'candidate-manifest.json'),
    JSON.stringify({ projectId: 'prrib', preparedAt: new Date().toISOString(), status: 'staged-only', records }, null, 2),
    { flag: 'wx' });
console.log(JSON.stringify({ status: 'staged-only', backup, agents: records.map(r => ({ file: r.file, blocks: r.blocks })) }, null, 2));