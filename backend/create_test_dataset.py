from openpyxl import Workbook
path = r'c:/Users/Akshat Dwivedi/Desktop/internship/project_3/CLA-online/backend/test_golden_dataset.xlsx'
wb = Workbook()
ws = wb.active
ws.title = 'Dataset'
ws.append(['id','question','intent','answer','source_table','source_column','row_id','notes'])
ws.append(['q1','Does SEBI monitoring differ between IPO and FPO?','comparison','SEBI monitoring is similar for IPO and FPO.','sebi_regulations','monitoring_role','1','sample'])
ws.append(['q2','Can a director assign his office?','legal','A director cannot assign their office.','companies_act','office_assignment','2','sample'])
wb.save(path)
print(path)
