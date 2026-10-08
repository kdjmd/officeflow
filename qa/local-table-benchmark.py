import json
import re
import time

CASES = [
    {
        "name": "repeated_key_value",
        "text": "客户：张三\n电话：13800000001\n金额：1280.50元\n\n客户：李四\n电话：13900000002\n金额：860元",
        "gold": [
            {"客户": "张三", "电话": "13800000001", "金额": "1280.50元"},
            {"客户": "李四", "电话": "13900000002", "金额": "860元"},
        ],
        "expect_ai": False,
    },
    {
        "name": "markdown_table",
        "text": "|产品|规格|数量|\n|---|---|---|\n|炒锅|32cm|120|\n|煎锅|28cm|80|",
        "gold": [
            {"产品": "炒锅", "规格": "32cm", "数量": "120"},
            {"产品": "煎锅", "规格": "28cm", "数量": "80"},
        ],
        "expect_ai": False,
    },
    {
        "name": "free_prose",
        "text": "华东区域本月整体表现较好。张三负责的客户续约存在风险，建议在九月十五日前完成沟通；李四负责交付，计划九月二十日验收。",
        "gold": [
            {"负责人": "张三", "事项": "客户续约沟通", "截止日期": "九月十五日"},
            {"负责人": "李四", "事项": "交付验收", "截止日期": "九月二十日"},
        ],
        "expect_ai": True,
    },
    {
        "name": "ocr_noise",
        "text": "客 户;王五\n电 话：l3800000003\n金 额 560 元\n\n客户：赵六\n电话：13700000004\n金额：720元",
        "gold": [
            {"客户": "王五", "电话": "13800000003", "金额": "560元"},
            {"客户": "赵六", "电话": "13700000004", "金额": "720元"},
        ],
        "expect_ai": True,
    },
]


def parse_markdown(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) < 3 or not all(line.startswith("|") and line.endswith("|") for line in lines):
        return None
    headers = [cell.strip() for cell in lines[0].strip("|").split("|")]
    if not all(re.fullmatch(r"-+", cell.strip()) for cell in lines[1].strip("|").split("|")):
        return None
    rows = []
    for line in lines[2:]:
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) == len(headers):
            rows.append(dict(zip(headers, cells)))
    return rows


def parse_key_values(text):
    blocks = [block for block in re.split(r"\n\s*\n", text.strip()) if block.strip()]
    rows = []
    for block in blocks:
        row = {}
        for line in block.splitlines():
            match = re.match(r"^\s*([^:：]{1,20})\s*[:：]\s*(.+?)\s*$", line)
            if match:
                row[match.group(1).strip()] = match.group(2).strip()
        if len(row) >= 2:
            rows.append(row)
    if len(rows) < 1:
        return None
    common = set(rows[0])
    for row in rows[1:]:
        common &= set(row)
    return rows if len(common) >= 2 else None


def extract(text):
    rows = parse_markdown(text)
    method = "native_table"
    if rows is None:
        rows = parse_key_values(text)
        method = "key_value"
    if rows is None:
        return {"method": "ledger_fallback", "rows": [], "needs_ai": True, "source_coverage": 1.0}
    extracted_values = [str(value) for row in rows for value in row.values()]
    coverage = sum(value in text for value in extracted_values) / max(1, len(extracted_values))
    nonempty_lines = [line for line in text.splitlines() if line.strip()]
    matched_lines = [line for line in nonempty_lines if re.match(r"^\s*[^:：]{1,20}\s*[:：]\s*.+?\s*$", line)]
    structural_coverage = 1.0 if method == "native_table" else len(matched_lines) / max(1, len(nonempty_lines))
    needs_ai = coverage < 1.0 or structural_coverage < 0.80
    return {
        "method": method,
        "rows": rows,
        "needs_ai": needs_ai,
        "source_coverage": coverage,
        "structural_coverage": structural_coverage,
    }


def score(predicted, gold):
    gold_cells = [(index, key, value) for index, row in enumerate(gold) for key, value in row.items()]
    correct = 0
    for index, key, value in gold_cells:
        if index < len(predicted) and predicted[index].get(key) == value:
            correct += 1
    return correct / max(1, len(gold_cells))


started = time.perf_counter()
results = []
for case in CASES:
    result = extract(case["text"])
    results.append({
        "name": case["name"],
        "method": result["method"],
        "cell_accuracy": round(score(result["rows"], case["gold"]), 4),
        "source_coverage": round(result["source_coverage"], 4),
        "needs_ai": result["needs_ai"],
        "routing_correct": result["needs_ai"] == case["expect_ai"],
        "ai_tokens_used": 0,
    })

summary = {
    "cases": results,
    "structured_local_accuracy": round(sum(item["cell_accuracy"] for item in results[:2]) / 2, 4),
    "routing_accuracy": round(sum(item["routing_correct"] for item in results) / len(results), 4),
    "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
    "total_ai_tokens_used": 0,
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
