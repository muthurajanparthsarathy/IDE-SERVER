const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const app = express();

app.use(express.json());

const port = process.env.PORT || 3001;

app.post('/run', async (req, res) => {
  try {
    const { code, testCases, action } = req.body;

    const tempDir = path.join(os.tmpdir(), "docker-code-run");
    const filePath = path.join(tempDir, "user.py");

    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    let pythonCode = code;

    // If running tests, wrap the code with test execution logic
    if (action === "test" && testCases && testCases.length > 0) {
      pythonCode = generateTestCode(code, testCases);
    }

    fs.writeFileSync(filePath, pythonCode);

    const cmd = `docker run --rm -v "${tempDir}:/app" python:3.12-alpine python /app/user.py`;

    exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
      let output = "";
      if (stdout) output += stdout;
      if (stderr) output += stderr;
      if (err) output += "\n[ERROR] Execution timeout or crash.";

      // Parse test results if running tests
      if (action === "test" && testCases && testCases.length > 0) {
        try {
          const results = parseTestResults(output);
          const passedCount = results.filter(r => r.passed).length;
          const totalCount = results.length;

          res.json({
            success: true,
            output: output.trim(),
            results: results,
            summary: `Tests: ${passedCount}/${totalCount} passed`
          });
          return;
        } catch (parseError) {
          // If parsing fails, return normal output
          console.error("Parse error:", parseError);
        }
      }

      res.json({
        success: true,
        output: output.trim(),
      });
    });
  } catch (err) {
    res.json({
      success: false,
      output: "Server Error: " + err.message
    });
  }
});

function generateTestCode(userCode, testCases) {
  // ... same as in route.ts ...
}

function parseTestResults(output) {
  // ... same as in route.ts ...
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});