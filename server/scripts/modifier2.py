with open('seed_synthetic_demo.py', 'a', encoding='utf-8') as f:
    # Just need to check if we already appended this
    pass

import re
with open('seed_synthetic_demo.py', 'r', encoding='utf-8') as f:
    code = f.read()

if 'seed_quote_requests' not in code:
    code = code.replace('from app.models.policy import Policy', 'from app.models.policy import Policy\nfrom app.models.document import DocumentRecord\nfrom app.models.quote_request import QuoteRequest, QuoteOption, QuoteEvent, QuoteStage')
    
    quote_requests_func = '''
async def seed_quote_requests(owner, partners, policies):
    print("\\n--- Quote Requests & Renewals ---")
    now = utcnow()
    made = 0
    # Create some quote requests
    for p in policies[:15]:
        partner = partners[0] if partners else None
        if not partner: break
        is_renewal = bool(made % 2)
        stage = QuoteStage.CLOSED if made % 2 else QuoteStage.SUBMITTED
        qr = QuoteRequest(
            code=await next_code("quote"), partner_id=str(partner.id), partner_name=partner.full_name,
            customer_name=f"Customer {made}", customer_mobile=f"98100100{made}",
            category_key="motor",
            is_renewal=is_renewal,
            renewal_of_policy_id=str(p.id) if is_renewal else None,
            stage=stage,
            created_at=now - timedelta(days=random.randint(1, 395))
        )
        await qr.insert()
        made += 1
    print(f"  + {made} quote requests")
    
async def seed_documents(policies):
    print("\\n--- Documents ---")
    made = 0
    for p in policies:
        doc = DocumentRecord(
            entity_type="policy", entity_id=str(p.id),
            label="Policy PDF", s3_key=f"policies/{p.id}/policy.pdf",
            filename="policy.pdf", content_type="application/pdf",
            size_bytes=1024 * 1024 * 2
        )
        await doc.insert()
        made += 1
    print(f"  + {made} policy documents")
'''
    code = code.replace('async def main() -> None:', quote_requests_func + '\nasync def main() -> None:')
    
    main_additions = '''
    await seed_quote_requests(owner, partners, policies)
    await seed_documents(policies)
'''
    code = code.replace('await seed_targets(employees, partners)', 'await seed_targets(employees, partners)\n' + main_additions)

with open('seed_synthetic_demo.py', 'w', encoding='utf-8') as f:
    f.write(code)
