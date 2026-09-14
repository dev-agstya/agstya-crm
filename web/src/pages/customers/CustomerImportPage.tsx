import { customersApi } from "../../api/endpoints";
import { ImportPage } from "../../components/ImportPage";

export default function CustomerImportPage() {
  return (
    <ImportPage
      backTo="/customers"
      backLabel="Back to customers"
      title="Import customers"
      noun="customer"
      columns="Full Name, Mobile, Email, Notes"
      note="Each customer needs a unique 10-digit mobile — a row whose number
        already exists is reported rather than creating a duplicate."
      templateFilename="customer_import_template.xlsx"
      downloadTemplate={() => customersApi.downloadTemplate()}
      runImport={(file, onProgress) => customersApi.import(file, onProgress)}
      invalidateKey="customers"
    />
  );
}
