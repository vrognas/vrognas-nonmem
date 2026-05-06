import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadLineageNodeInput } from '../../src/views/lineage-discovery';

async function workdir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

const EXT_FIXTURE = `TABLE NO.  1: First Order Conditional Estimation
 ITERATION    THETA1       OMEGA(1,1)   SIGMA(1,1)   OBJ
            0   1.0000E+00   1.0000E-01   1.0000E+00   1.7976E+308
 -1000000000   2.5230E+00   1.8430E-01   4.1100E-02   -6.3879E+02
 -1000000001   1.2300E-01   2.5000E-02   8.0100E-03   0.0000E+00
`;

describe('loadLineageNodeInput', () => {
  it('non-`run<NNN>` model basenames still load (orphan node, runNumber=null)', async () => {
    // v0.0.79: lineage now includes any .mod / .ctl file so the user
    // can construct lineage in hindsight via Edit Run Notes. Pirana
    // `m.mod` and hand-rolled names appear as roots; `runNumber` is
    // null so they can't be referenced as parent targets but they
    // still show up as nodes.
    const dir = await workdir('lineage-orphan');
    const modelPath = path.join(dir, 'm.mod');
    await fs.writeFile(modelPath, '$PROBLEM Test\n');
    const input = await loadLineageNodeInput(modelPath);
    expect(input).not.toBeNull();
    expect(input!.runNumber).toBeNull();
    expect(input!.basename).toBe('m');
    expect(input!.basedOn).toBeNull();
  });

  it('parses runrecord + sibling .lst + .ext into a complete LineageNodeInput', async () => {
    const dir = await workdir('lineage-full');
    const modelPath = path.join(dir, 'run002.mod');
    await fs.writeFile(
      modelPath,
      [
        '$PROBLEM Adds CL-WT covariate',
        ';; Based on: 1',
        ';; Description:',
        ';; Add CL ~ WT',
        ';; Label:',
        ';; Cov model',
        '$INPUT ID TIME DV',
      ].join('\n'),
    );
    await fs.writeFile(path.join(dir, 'run002.lst'), '');
    await fs.writeFile(path.join(dir, 'run002.ext'), EXT_FIXTURE);

    const input = await loadLineageNodeInput(modelPath);
    expect(input).not.toBeNull();
    expect(input!.runNumber).toBe(2);
    expect(input!.basename).toBe('run002');
    expect(input!.basedOn).toBe(1);
    expect(input!.computeDeltaOfv).toBe(true);
    expect(input!.description).toBe('Add CL ~ WT');
    expect(input!.label).toBe('Cov model');
    expect(input!.ofv).toBeCloseTo(-638.79, 1);
    expect(input!.lstPath).toBe(path.join(dir, 'run002.lst'));
  });

  it('missing .lst → lstPath null, ofv null (model not yet run)', async () => {
    const dir = await workdir('lineage-pending');
    const modelPath = path.join(dir, 'run003.mod');
    await fs.writeFile(modelPath, '$PROBLEM pending\n;; Based on: 2\n');
    const input = await loadLineageNodeInput(modelPath);
    expect(input).not.toBeNull();
    expect(input!.lstPath).toBeNull();
    expect(input!.ofv).toBeNull();
    expect(input!.basedOn).toBe(2);
  });

  it('present .lst but missing .ext → ofv null (run started, didn\'t finish)', async () => {
    const dir = await workdir('lineage-partial');
    const modelPath = path.join(dir, 'run004.mod');
    await fs.writeFile(modelPath, '$PROBLEM partial\n');
    await fs.writeFile(path.join(dir, 'run004.lst'), '');
    const input = await loadLineageNodeInput(modelPath);
    expect(input!.lstPath).toBe(path.join(dir, 'run004.lst'));
    expect(input!.ofv).toBeNull();
  });

  it('honors `[nodOFV]` modifier: computeDeltaOfv=false (gray edge upstream)', async () => {
    const dir = await workdir('lineage-noofv');
    const modelPath = path.join(dir, 'run005.mod');
    await fs.writeFile(modelPath, '$PROBLEM noOFV\n;; Based on: 4 [nodOFV]\n');
    const input = await loadLineageNodeInput(modelPath);
    expect(input!.basedOn).toBe(4);
    expect(input!.computeDeltaOfv).toBe(false);
  });
});
