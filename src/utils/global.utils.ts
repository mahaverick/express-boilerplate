// import { ValidationError } from 'express-validator';

// /**
//  * This function formats validation errors
//  * @param errors
//  * @returns
//  */
// export function formatValidationErrors(errors: ValidationError[]): Record<string, string> {
//   return errors.reduce(
//     (acc, error) => {
//       if ('path' in error) {
//         // This is for FieldValidationError
//         acc[error.path] = error.msg;
//       } else if (error.type === 'alternative') {
//         // This is for AlternativeValidationError
//         error.nestedErrors.forEach((nestedError) => {
//           if ('path' in nestedError) {
//             acc[nestedError.path] = nestedError.msg;
//           }
//         });
//       }
//       return acc;
//     },
//     {} as Record<string, string>,
//   );
// }
