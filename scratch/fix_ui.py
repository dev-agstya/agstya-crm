import os

path = 'd:/InsuranceCRM/software/v1/web/src/pages/settings/AttendanceSettingsPage.tsx'
with open(path, 'r', encoding='utf8') as f:
    content = f.read()

content = content.replace('Section, ToggleField', 'Section, Tabs, ToggleField')
content = content.replace('const [form, setForm] = useState<HrSettings | null>(null);', 
    'const [form, setForm] = useState<HrSettings | null>(null);\n  const [tab, setTab] = useState<string>("shift");')

tabs_insert = """
          <Tabs
            items={[
              { value: 'shift', label: 'Shift & Hours' },
              { value: 'location', label: 'Location Tracking' },
              { value: 'payroll', label: 'Payroll & Penalties' },
              { value: 'leave', label: 'Leave Policy' }
            ]}
            value={tab}
            onChange={setTab}
          />
"""

content = content.replace('<div className="max-w-2xl space-y-6">\n          <div className="note-due">', 
    '<div className="max-w-2xl space-y-6">\n' + tabs_insert + '          <div className="note-due">')

content = content.replace('{/* ------------------------------------------------- the week -- */}', 
    '{tab === "shift" && (<>\n          {/* ------------------------------------------------- the week -- */}')

content = content.replace('{/* ------------------------------------------------ late marks -- */}', 
    '</>)}\n          {tab === "payroll" && (<>\n          {/* ------------------------------------------------ late marks -- */}')

content = content.replace('{/* ------------------------------------------------- location -- */}', 
    '</>)}\n          {tab === "location" && (<>\n          {/* ------------------------------------------------- location -- */}')

content = content.replace('{/* --------------------------------------------------- payroll -- */}', 
    '</>)}\n          {tab === "payroll" && (<>\n          {/* --------------------------------------------------- payroll -- */}')

content = content.replace('{/* ---------------------------------------------------- leave -- */}', 
    '</>)}\n          {tab === "leave" && (<>\n          {/* ---------------------------------------------------- leave -- */}')

content = content.replace('</div>\n\n          <div className="flex items-center justify-end gap-2">', 
    '</div>\n          </>)}\n\n          <div className="flex items-center justify-end gap-2">')

with open(path, 'w', encoding='utf8') as f:
    f.write(content)
print('Done!')

