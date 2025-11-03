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

// Configuration
const config = {
  docker: {
    image: 'python:3.12-alpine',
    timeout: 10000
  },
  limits: {
    maxCodeSize: 1024 * 100, // 100KB
    maxExecutionTime: 10 // seconds
  }
};

// Helper function to clean up temporary files
const cleanupTempFile = (filePath: string) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Error cleaning up temp file:', error);
  }
};

router.post('/', async (req: Request, res: Response) => {
  let tempDir: string = '';
  let filePath: string = '';

  try {
    const { code, testCases, action } = req.body;

    // Validate input
    if (!code || typeof code !== 'string') {
      return res.status(400).json({
        success: false,
        output: "Invalid code provided"
      });
    }

    // Check code size limit
    if (code.length > config.limits.maxCodeSize) {
      return res.status(400).json({
        success: false,
        output: `Code too large. Maximum size is ${config.limits.maxCodeSize} characters.`
      });
    }

    tempDir = path.join(os.tmpdir(), "docker-code-run");
    filePath = path.join(tempDir, "user.py");

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    let pythonCode = code;

    // If running tests, wrap the code with test execution logic
    if (action === "test" && testCases && testCases.length > 0) {
      // Validate test cases
      if (testCases.length > 10) {
        return res.status(400).json({
          success: false,
          output: "Too many test cases. Maximum is 10."
        });
      }
      pythonCode = generateTestCode(code, testCases);
    }

    fs.writeFileSync(filePath, pythonCode);

    const cmd = `docker run --rm --memory=100m --cpus=1.0 -v "${tempDir}:/app" ${config.docker.image} python /app/user.py`;

    console.log(`Executing Docker command for ${action} action`);

    exec(cmd, { timeout: config.docker.timeout }, (err, stdout, stderr) => {
      // Clean up temporary file
      cleanupTempFile(filePath);

      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += stderr;
      if (err) {
        if (err.signal === 'SIGTERM') {
          output += "\n[ERROR] Execution timeout - code took too long to run.";
        } else {
          output += `\n[ERROR] Execution failed: ${err.message}`;
        }
      }

      // Parse test results if running tests
      if (action === "test" && testCases && testCases.length > 0) {
        try {
          const results = parseTestResults(output);
          const passedCount = results.filter((r: TestResult) => r.passed).length;
          const totalCount = results.length;

          return res.json({
            success: true,
            output: output.trim(),
            results: results,
            summary: `Tests: ${passedCount}/${totalCount} passed`
          });
        } catch (parseError) {
          console.error("Parse error:", parseError);
        }
      }

      res.json({
        success: true,
        output: output.trim(),
      });
    });
  } catch (err) {
    // Clean up temporary file in case of error
    if (filePath) {
      cleanupTempFile(filePath);
    }
    
    console.error('Server error:', err);
    res.status(500).json({
      success: false,
      output: "Server Error: " + (err as Error).message
    });
  }
});

function generateTestCode(userCode: string, testCases: TestCase[]): string {
  const testRunner = `
import sys
import json
from io import StringIO

# User's code
${userCode}

# Test execution
test_results = []

def capture_output(code_string, locals_dict):
    """Capture output from executing code"""
    try:
        old_stdout = sys.stdout
        sys.stdout = captured_output = StringIO()
        
        # Execute the code
        exec(code_string, {'__builtins__': {}}, locals_dict)
        
        # Get the captured output
        output = captured_output.getvalue().strip()
        sys.stdout = old_stdout
        return output, None
    except Exception as e:
        sys.stdout = old_stdout
        return None, str(e)

def safe_eval(expression, locals_dict):
    """Safely evaluate a Python expression"""
    try:
        # Only allow safe operations
        allowed_globals = {'__builtins__': {}}
        result = eval(expression, allowed_globals, locals_dict)
        return str(result), None
    except Exception as e:
        return None, str(e)

# Define available functions/classes from user's code
locals_dict = locals()

# Run each test case
${testCases.map(testCase => {
    if (testCase.input === "print_output") {
      return `
# Test main program output
try:
    # Capture output from running the main program
    output_code = """
if __name__ == "__main__":
    import sys
    old_argv = sys.argv
    sys.argv = [""]  # Clear command line arguments
    try:
        exec("""${userCode.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}""", globals())
    finally:
        sys.argv = old_argv
"""
    actual, error = capture_output(output_code, locals_dict)
    if error:
        test_results.append({
            "input": "print_output",
            "expected": "${testCase.expected.replace(/"/g, '\\"')}",
            "actual": "Error",
            "passed": False,
            "description": "${testCase.description.replace(/"/g, '\\"')}",
            "error": error
        })
    else:
        passed = str(actual).strip() == "${testCase.expected.replace(/"/g, '\\"')}".strip()
        test_results.append({
            "input": "print_output",
            "expected": "${testCase.expected.replace(/"/g, '\\"')}",
            "actual": str(actual),
            "passed": passed,
            "description": "${testCase.description.replace(/"/g, '\\"')}",
            "error": None
        })
except Exception as e:
    test_results.append({
        "input": "print_output",
        "expected": "${testCase.expected.replace(/"/g, '\\"')}",
        "actual": "Error",
        "passed": False,
        "description": "${testCase.description.replace(/"/g, '\\"')}",
        "error": str(e)
    })`;
    } else {
      return `
# Test function evaluation
try:
    actual, error = safe_eval("${testCase.input.replace(/"/g, '\\"')}", locals_dict)
    if error:
        test_results.append({
            "input": "${testCase.input.replace(/"/g, '\\"')}",
            "expected": "${testCase.expected.replace(/"/g, '\\"')}",
            "actual": "Error",
            "passed": False,
            "description": "${testCase.description.replace(/"/g, '\\"')}",
            "error": error
        })
    else:
        passed = str(actual).strip() == "${testCase.expected.replace(/"/g, '\\"')}".strip()
        test_results.append({
            "input": "${testCase.input.replace(/"/g, '\\"')}",
            "expected": "${testCase.expected.replace(/"/g, '\\"')}",
            "actual": str(actual),
            "passed": passed,
            "description": "${testCase.description.replace(/"/g, '\\"')}",
            "error": None
        })
except Exception as e:
    test_results.append({
        "input": "${testCase.input.replace(/"/g, '\\"')}",
        "expected": "${testCase.expected.replace(/"/g, '\\"')}",
        "actual": "Error",
        "passed": False,
        "description": "${testCase.description.replace(/"/g, '\\"')}",
        "error": str(e)
    })`;
    }
  }).join('\n')}

# Print results in JSON format for parsing
print("TEST_RESULTS_START")
print(json.dumps(test_results, indent=2))
print("TEST_RESULTS_END")
`;

  return testRunner;
}

function parseTestResults(output: string): TestResult[] {
  try {
    // Extract JSON between markers
    const startMarker = "TEST_RESULTS_START";
    const endMarker = "TEST_RESULTS_END";

    const startIndex = output.indexOf(startMarker);
    const endIndex = output.indexOf(endMarker);

    if (startIndex >= 0 && endIndex > startIndex) {
      const jsonStr = output.substring(startIndex + startMarker.length, endIndex).trim();
      return JSON.parse(jsonStr);
    }

    // If no JSON found, return empty results
    return [];
  } catch (error) {
    console.error("Error parsing test results:", error);
    return [];
  }
}

export default router;