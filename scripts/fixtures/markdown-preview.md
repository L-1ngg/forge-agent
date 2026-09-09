# Markdown 阅读验收

**加粗跨行仍保持样式：中文与 English 可以一起阅读。** *斜体*、~~删除线~~、`inline code`。

1. 阅读正文，然后打开详情。
   - 缩窄窗口，检查换行。
   - 拖选文字，粘贴检查 Markdown 原文。

> 引用保留结构；详情页可搜索“验收”。

## 表格

| 名称 | 状态 | 说明 |
| :--- | :---: | :--- |
| Markdown | ready | 表格优先单元格换行，过窄时转为逐条记录 |
| LaTeX | excluded | $\frac{x_i}{y_j}$ 保留原文 |

## 代码

```ts
function describe(name: string): string {
    return `A deliberately long line for ${name}: Chinese 中文 and syntax highlighting should survive terminal wrapping.`;
}
```

```python
answer = {"name": "Forge", "count": 42}
print(answer)
```

```bash
printf '%s\n' "hello world"
```

```json
{"supported": true, "count": 42}
```

```unknown
**this stays code**
```

[Forge 文档](https://github.com/L-1ngg/forge-agent)；[https://example.com](https://example.com)。

---

输入任意文字并回车，会逐段重放本样例；按 Ctrl+C 退出。此样例不调用模型，也不保存会话。
