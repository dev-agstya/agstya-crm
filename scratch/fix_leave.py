import os

path = 'd:/InsuranceCRM/software/v1/web/src/pages/hr/LeavePage.tsx'
with open(path, 'r', encoding='utf8') as f:
    content = f.read()

content = content.replace(
'''        actions={
          <button className="btn-primary" onClick={() => {
            setOnBehalf(null);
            setApplying(true);
          }}>
            <Icon.Plus size={15} /> Apply for leave
          </button>
        }''',
'''        actions={
          user?.account_type !== "owner" ? (
            <button className="btn-primary" onClick={() => {
              setOnBehalf(null);
              setApplying(true);
            }}>
              <Icon.Plus size={15} /> Apply for leave
            </button>
          ) : undefined
        }''')

content = content.replace(
'''              action={
                <button className="btn-primary"
                  onClick={() => setApplying(true)}>
                  Apply for leave
                </button>
              } />''',
'''              action={
                user?.account_type !== "owner" ? (
                  <button className="btn-primary"
                    onClick={() => setApplying(true)}>
                    Apply for leave
                  </button>
                ) : undefined
              } />''')

with open(path, 'w', encoding='utf8') as f:
    f.write(content)
print("Done")

