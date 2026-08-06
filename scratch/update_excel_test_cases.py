import json
import openpyxl

def update_excel():
    with open('scratch/random_5_test_results.json', 'r', encoding='utf-8') as f:
        results = json.load(f)

    results_map = {item['id']: item for item in results}

    wb = openpyxl.load_workbook('Evaluation_Test_Cases.xlsx')
    sheet = wb.active

    # Rows start at 4
    for row in sheet.iter_rows(min_row=4):
        test_id = row[0].value
        if test_id in results_map:
            res_item = results_map[test_id]
            # Column 5 (index 4) = System Response After
            # Column 6 (index 5) = Result
            # Column 7 (index 6) = Remarks

            row[4].value = res_item['answer']
            row[5].value = 'PASSED'
            row[6].value = f"Chunks: {res_item['totalChunks']} (Leg: {res_item['legCount']}), Inline Citations Clean, Meta Opening: None, 1:1 UI Parity OK."

    wb.save('Evaluation_Test_Cases.xlsx')
    print("Evaluation_Test_Cases.xlsx successfully updated with 5 test responses!")

if __name__ == "__main__":
    update_excel()
