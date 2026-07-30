import zipfile, sys
import xml.etree.ElementTree as ET

sys.stdout.reconfigure(encoding='utf-8')
docx_path = r"c:\Users\hp\Desktop\Legal\CLA_Online_Before_After_Comparison.docx"

with zipfile.ZipFile(docx_path) as z:
    xml_content = z.read("word/document.xml")

root = ET.fromstring(xml_content)

paragraphs = []
for p in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p'):
    texts = [node.text for node in p.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t') if node.text]
    full_text = "".join(texts).strip()
    if full_text:
        paragraphs.append(full_text)

questions = []
for p in paragraphs:
    if p.startswith("Question ") or "Question" in p[:15]:
        questions.append(p)

print(f"FOUND {len(questions)} QUESTIONS:\n")
for i, q in enumerate(questions, 1):
    print(f"Q{i}: {q}")
