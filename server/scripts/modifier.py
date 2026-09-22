import re

with open('seed_synthetic_demo.py', 'r', encoding='utf-8') as f:
    code = f.read()

# 1. Accounts
code = re.sub(r'EMAIL_DOMAIN = .*?\nLOCAL_PREFIX = .*?\nPASSWORD = .*?\nSEED_TAG = .*?\n\n\ndef email_for\(tag: str\) -> str:\n    return f"\{LOCAL_PREFIX\}\+\{tag\}@\{EMAIL_DOMAIN\}"',
'''EMAIL_DOMAIN = "agstyaassociate.in"
PASSWORD = "Test@123"
SEED_TAG = "[demo]"

def email_for(tag: str) -> str:
    if tag == "owner": return "owner@agstyaassociate.in"
    if tag.startswith("emp"): return f"emp_{tag[3:]}@agstyaassociate.in"
    if tag.startswith("cp"): return f"cp_{tag[2:]}@agstyaassociate.in"
    return f"{tag}@agstyaassociate.in"''', code)

# 2. Customers
# replace the CUSTOMERS list with 55 names
customers_55 = [f"Customer {i}" for i in range(1, 56)]
code = re.sub(r'CUSTOMERS = \[\n.*?\]', f'CUSTOMERS = {customers_55}', code, flags=re.DOTALL)

# 3. Leads
leads_55 = []
for i in range(1, 56):
    stage = "LeadStage.NEW"
    ltype = "LeadType.CUSTOMER"
    if i % 3 == 0: stage = "LeadStage.CONTACTED"
    if i % 4 == 0: stage = "LeadStage.QUOTED"
    if i % 5 == 0: ltype = "LeadType.BUSINESS"
    leads_55.append(f'("Lead {i}", "9700300{i:03d}", "Interest {i}", {100000 + i*1000}, {ltype}, {stage})')
code = re.sub(r'LEADS = \[\n.*?\]', f'LEADS = [\n    ' + ',\n    '.join(leads_55) + '\n]', code, flags=re.DOTALL)

# 4. Channel partners
# Upsert 10 partners, but only 2 have portal_access=True
code = re.sub(
    r'names = \["Yogesh Sharma", "Ayesha Khan"\]\n    for i, \(tag, name\) in enumerate\(zip\(\["cp1", "cp2"\], names\), start=1\):',
    '''names = ["Yogesh Sharma", "Ayesha Khan"] + [f"Partner {i}" for i in range(3, 11)]
    tags = ["cp1", "cp2"] + [f"cp{i}" for i in range(3, 11)]
    for i, (tag, name) in enumerate(zip(tags, names), start=1):''', code
)
code = re.sub(r'portal_access=True', 'portal_access=(i<=2)', code)

# 5. Policies
# 70 policies over last 13 months (395 days)
code = re.sub(r'for n in range\(24\):', 'for n in range(70):', code)
code = re.sub(r'started = now - timedelta\(days=random.randint\(5, 175\)\)', 'started = now - timedelta(days=random.randint(5, 395))', code)

# 6. Targets over 13 months
code = re.sub(r'for _back in range\(3\):', 'for _back in range(14):', code)

# 7. Attendance
code = re.sub(r'for back in range\(1, 46\):', 'for back in range(1, 396):', code)
code = re.sub(r'if back % 14 == 0:', 'if back % 20 == 0:', code) # absent less often

# 8. Leave
code = re.sub(r'for _back in range\(3\):', 'for _back in range(14):', code)

# 9. Holidays
code = re.sub(
    r'holidays = \[\(f"\{year\}-01-26", "Republic Day"\),\n                \(f"\{year\}-08-15", "Independence Day"\),\n                \(f"\{year\}-10-02", "Gandhi Jayanti"\)\]',
    'holidays = [(f"{year}-01-26", "Republic Day"), (f"{year}-08-15", "Independence Day"), (f"{year}-10-02", "Gandhi Jayanti"), (f"{year}-05-01", "Labour Day"), (f"{year}-12-25", "Christmas")]', code
)

with open('seed_synthetic_demo.py', 'w', encoding='utf-8') as f:
    f.write(code)
