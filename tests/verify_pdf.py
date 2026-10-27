"""Read/render generated test PDFs. Uses the bundled Python PDF libraries."""
import json
import sys
from pathlib import Path
from pypdf import PdfReader
import pypdfium2 as pdfium

pdf_path = Path(sys.argv[1]).resolve()
reader = PdfReader(pdf_path)
text = '\n'.join(page.extract_text() or '' for page in reader.pages)
assert len(reader.pages) >= 3, f'Expected pagination, got {len(reader.pages)}'
for expected in ['精确还原测试', 'ABC123', '历史回答 8.10', '代码缩进仍在']:
    assert expected in text, f'Missing searchable text: {expected}'
assert '另一个分支的回答' not in text, 'Unselected branch leaked into PDF'
attachments = dict(reader.attachments)
assert 'notes.txt' in attachments, f'Attachments missing: {list(attachments)}'
assert attachments['notes.txt'][0] == '附件原始内容：保留字节。\nfixture attachment\n'.encode('utf-8')
document = pdfium.PdfDocument(str(pdf_path))
for page_index in [0, 1, len(document) - 1]:
    page = document[page_index]
    image = page.render(scale=1.8).to_pil()
    image.save(pdf_path.parent / f'pdf-page-{page_index + 1}.png')
summary = {'pages': len(reader.pages), 'searchableTextCharacters': len(text),
           'embeddedFiles': list(attachments), 'renderedPages': [1, 2, len(document)]}
(pdf_path.parent / 'pdf-verification.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
(pdf_path.parent / 'pdf-text.txt').write_text(text, encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False))
