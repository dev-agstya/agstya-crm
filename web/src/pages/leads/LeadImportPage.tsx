import { leadsApi } from "../../api/endpoints";
import { ImportPage } from "../../components/ImportPage";

export default function LeadImportPage() {
  return (
    <ImportPage
      backTo="/leads"
      backLabel="Back to leads"
      title="Import leads"
      noun="lead"
      columns="Full Name, Type, Mobile, Email, Interested In, Note"
      note="Type accepts Customer, Channel partner or Business — leave it blank
        for Customer."
      templateFilename="lead_import_template.xlsx"
      downloadTemplate={() => leadsApi.downloadTemplate()}
      runImport={(file, onProgress) => leadsApi.import(file, onProgress)}
      invalidateKey="leads"
    />
  );
}
