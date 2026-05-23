const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const qrcode = require('qrcode');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 数据库初始化
const db = new sqlite3.Database('./ahp.db', (err) => {
  if (err) {
    console.error(err.message);
  }
  console.log('Connected to the AHP database.');
});

// 创建表
db.run(`CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT,
  factors TEXT,
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.run(`CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  judge_id TEXT,
  matrix TEXT,
  completed INTEGER DEFAULT 0,
  submitted_at DATETIME
)`);

// API接口

// 创建新项目
app.post('/api/projects', (req, res) => {
  const { name, factors } = req.body;
  const id = Math.random().toString(36).substring(2, 10);
  
  db.run(`INSERT INTO projects (id, name, factors) VALUES (?, ?, ?)`, 
    [id, name, JSON.stringify(factors)], 
    (err) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      res.json({ id, name, factors });
    }
  );
});

// 获取项目信息
app.get('/api/projects/:id', (req, res) => {
  const { id } = req.params;
  
  db.get(`SELECT * FROM projects WHERE id = ?`, [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json({
      ...row,
      factors: JSON.parse(row.factors)
    });
  });
});

// 获取项目投票统计
app.get('/api/projects/:id/stats', (req, res) => {
  const { id } = req.params;
  
  db.all(`SELECT * FROM votes WHERE project_id = ?`, [id], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    const total = rows.length;
    const completed = rows.filter(row => row.completed === 1).length;
    
    res.json({
      total_judges: total,
      completed_judges: completed,
      votes: rows.map(row => ({
        judge_id: row.judge_id,
        completed: row.completed,
        submitted_at: row.submitted_at
      }))
    });
  });
});

// 提交投票
app.post('/api/projects/:id/votes', (req, res) => {
  const { id } = req.params;
  const { judge_id, matrix, completed } = req.body;
  
  // 检查项目是否还在进行中
  db.get(`SELECT status FROM projects WHERE id = ?`, [id], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!row) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (row.status !== 'active') {
      return res.status(403).json({ error: 'Voting has ended' });
    }
    
    // 检查是否已经提交过
    db.get(`SELECT id FROM votes WHERE project_id = ? AND judge_id = ?`, 
      [id, judge_id], 
      (err, existingRow) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        
        if (existingRow) {
          // 更新现有投票
          db.run(`UPDATE votes SET matrix = ?, completed = ?, submitted_at = CURRENT_TIMESTAMP 
                  WHERE id = ?`, 
            [JSON.stringify(matrix), completed ? 1 : 0, existingRow.id], 
            (err) => {
              if (err) {
                return res.status(500).json({ error: err.message });
              }
              // 通知后台有新投票
              io.emit('vote_update', { project_id: id });
              res.json({ success: true });
            }
          );
        } else {
          // 创建新投票
          db.run(`INSERT INTO votes (project_id, judge_id, matrix, completed) 
                  VALUES (?, ?, ?, ?)`, 
            [id, judge_id, JSON.stringify(matrix), completed ? 1 : 0], 
            (err) => {
              if (err) {
                return res.status(500).json({ error: err.message });
              }
              // 通知后台有新投票
              io.emit('vote_update', { project_id: id });
              res.json({ success: true });
            }
          );
        }
      }
    );
  });
});

// 停止投票并计算结果
app.post('/api/projects/:id/stop', (req, res) => {
  const { id } = req.params;
  
  // 更新项目状态
  db.run(`UPDATE projects SET status = 'completed' WHERE id = ?`, [id], (err) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    
    // 获取所有完成的投票
    db.all(`SELECT matrix FROM votes WHERE project_id = ? AND completed = 1`, [id], (err, rows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      if (rows.length === 0) {
        return res.status(400).json({ error: 'No completed votes' });
      }
      
      // 解析所有矩阵
      const matrices = rows.map(row => JSON.parse(row.matrix));
      
      // 计算综合判断矩阵
      const n = matrices[0].length;
      const m = matrices.length;
      const combinedMatrix = Array(n).fill().map(() => Array(n).fill(1));
      
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          let product = 1;
          for (let k = 0; k < m; k++) {
            product *= matrices[k][i][j];
          }
          combinedMatrix[i][j] = Math.pow(product, 1/m);
        }
      }
      
      // 计算权重
      const geometricMeans = [];
      for (let i = 0; i < n; i++) {
        let product = 1;
        for (let j = 0; j < n; j++) {
          product *= combinedMatrix[i][j];
        }
        geometricMeans.push(Math.pow(product, 1/n));
      }
      
      const sum = geometricMeans.reduce((a, b) => a + b, 0);
      const weights = geometricMeans.map(gm => gm / sum);
      
      // 计算一致性
      const consistency = calculateConsistency(combinedMatrix, weights);
      
      // 获取因素列表
      db.get(`SELECT factors FROM projects WHERE id = ?`, [id], (err, projectRow) => {
        if (err) {
          return res.status(500).json({ error: err.message });
        }
        
        const factors = JSON.parse(projectRow.factors);
        
        // 生成排名
        const rankedFactors = factors.map((factor, index) => ({
          name: factor,
          weight: weights[index],
          rank: 0
        })).sort((a, b) => b.weight - a.weight);
        
        rankedFactors.forEach((item, index) => {
          item.rank = index + 1;
        });
        
        res.json({
          total_judges: m,
          combined_matrix: combinedMatrix,
          weights: weights,
          ranked_factors: rankedFactors,
          consistency: consistency
        });
      });
    });
  });
});

// 生成二维码
app.get('/api/qrcode', (req, res) => {
  const { url } = req.query;
  
  qrcode.toDataURL(url, (err, data_url) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.send(`<img src="${data_url}" alt="QR Code" style="max-width: 300px;">`);
  });
});

// 计算一致性
function calculateConsistency(matrix, weights) {
  const n = matrix.length;
  if (n <= 2) {
    return { lambdaMax: n, CI: 0, CR: 0, isConsistent: true };
  }
  
  const weightedSum = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      sum += matrix[i][j] * weights[j];
    }
    weightedSum.push(sum);
  }
  
  let lambdaMax = 0;
  for (let i = 0; i < n; i++) {
    lambdaMax += weightedSum[i] / (n * weights[i]);
  }
  
  const CI = (lambdaMax - n) / (n - 1);
  const RI = [0, 0, 0.58, 0.90, 1.12, 1.24, 1.32, 1.41, 1.45, 1.49];
  const CR = CI / RI[n-1];
  
  return {
    lambdaMax: lambdaMax.toFixed(4),
    CI: CI.toFixed(4),
    CR: CR.toFixed(4),
    isConsistent: CR < 0.1
  };
}

// Socket.io实时通信
io.on('connection', (socket) => {
  console.log('A user connected');
  
  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`  权重大作战服务器启动成功！`);
  console.log(`  管理后台地址：http://localhost:3000/admin.html`);
  console.log(`  请在浏览器中打开上面的地址使用`);
  console.log(`=========================================`);
});