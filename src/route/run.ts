import { Router } from 'express';
import { exec } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { Request, Response } from 'express';

const router = Router();

interface TestCase {
  id: number;
  input: string;
  expected: string;
  description: string;
}

interface TestResult {
  input: string;
  expected: string;
  actual: string;
  passed: boolean;
  description: string;
  error?: string;
}

// Limits
const config = {
  limits: {
    maxCodeSize: 1024 * 100, // 100KB
    maxExecutionTime: 10000 // 10 seconds
  }
};

// Cleanup temp files
const cleanupTempFile = (filePath: string) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
};

router.post('/', async (req: Request, res: Response) => {
  let filePath: string = '';

  try {
    const { code, testCases, action } = req.body;

    if (!code) return res.status(400).json({ success: false, output: "No code provided" });
    if (code.length > config.limits.maxCodeSize)
      return res.status(400).json({ success: false, output: "Code too large" });

    const tempDir = path.join(os.tmpdir(), "code-run");
    filePath = path.join(tempDir, `user_${Date.now()}.py`);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    let pythonCode = code;
    if (action === "test" && testCases?.length > 0) pythonCode = generateTestCode(code, testCases);

    fs.writeFileSync(filePath, pythonCode);

    // ✅ Run Python directly (no Docker)
    const cmd = `python3 "${filePath}"`;

    exec(cmd, { timeout: config.limits.maxExecutionTime }, (err, stdout, stderr) => {
      cleanupTempFile(filePath);

      let output = stdout + stderr;
      if (err) output += `\nError: ${err.message}`;

      if (action === "test" && testCases?.length > 0) {
        const results = parseTestResults(output);
        const passed = results.filter(r => r.passed).length;

        return res.json({
          success: true,
          output: output.trim(),
          results,
          summary: `✅ ${passed}/${results.length} tests passed`
        });
      }

      res.json({ success: true, output: output.trim() });
    });
  } catch (err: any) {
    if (filePath) cleanupTempFile(filePath);
    res.status(500).json({ success: false, output: err.message });
  }
});

// ✅ Test runner generator stays same
function generateTestCode(userCode: string, testCases: TestCase[]): string {
  const testRunner = `
import sys, json
from io import StringIO

${userCode}

test_results = []

def run_test(expr, expected, desc):
    try:
        result = eval(expr, {'__builtins__': {}}, locals())
        passed = str(result) == str(expected)
        test_results.append({"input": expr,"expected": expected,"actual": str(result),"passed": passed,"description": desc})
    except Exception as e:
        test_results.append({"input": expr,"expected": expected,"actual": "Error","passed": False,"description": desc,"error": str(e)})

${testCases.map(tc => `run_test("${tc.input}", "${tc.expected}", "${tc.description}")`).join("\n")}

print("TEST_RESULTS_START")
print(json.dumps(test_results))
print("TEST_RESULTS_END")
`;
  return testRunner;
}

function parseTestResults(output: string): TestResult[] {
  const start = output.indexOf("TEST_RESULTS_START");
  const end = output.indexOf("TEST_RESULTS_END");
  if (start < 0 || end < 0) return [];
  const jsonText = output.substring(start + 18, end).trim();
  return JSON.parse(jsonText);
}

export default router;
